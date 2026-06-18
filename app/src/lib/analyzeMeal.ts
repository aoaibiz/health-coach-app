// Client-side bridge to POST /api/analyze-meal (Phase 3).
//
// The meal RECORD is always saved locally first (offline-first); analysis is a
// separate, retryable step. This module only does the network call + maps the
// grounded response into a MealNutrition. On failure/offline it throws — the
// caller keeps the record and shows an honest "解析できませんでした" state.

import type {
  EstimateConfidence,
  MealItem,
  MealNutrition,
  NutritionSourceKind,
} from "./types";
import { makeId } from "./date";
import { itemsToNutrition, toMealItem } from "./mealItems";

export const API_TOKEN_STORAGE_KEY = "health-app:apiToken";

/** Shape returned by the analyze-meal function (mirrors AnalyzeMealResponse). */
export interface AnalyzeMealApiResponse {
  items: Array<{
    name: string;
    grams: number;
    kcal: number | null;
    protein_g: number | null;
    fat_g: number | null;
    carb_g: number | null;
    source: string | null;
    sourceKind: NutritionSourceKind | null;
    sourceLabel: string | null;
    estimated: boolean;
    confidence: EstimateConfidence;
    matched: boolean;
    /** Matched DB row food_code (db items only). */
    foodCode?: string;
    /** Matched DB row per-100g figures (db items only) — for exact client recompute. */
    basisPer100g?: { kcal: number; protein_g: number; fat_g: number; carb_g: number };
  }>;
  totals: { kcal: number; protein_g: number; fat_g: number; carb_g: number };
  generatedBy: string;
  matchedCount: number;
  numberedCount: number;
  totalsIncludeEstimate: boolean;
}

export interface AnalyzeMealInput {
  /** Base64 JPEG (no data: prefix), already downsized by the caller. Single-photo. */
  imageBase64?: string;
  /**
   * Multiple base64 JPEGs for ONE meal (e.g. main dish + side + drink shot taken
   * separately), already downsized by the caller. Sent together so the backend
   * analyses the whole meal in one grounded call and returns one item list.
   */
  imageBase64List?: string[];
  text?: string;
}

/** Lowest confidence across the items that produced a number — honest summary. */
function summarizeConfidence(res: AnalyzeMealApiResponse): EstimateConfidence {
  const order: Record<EstimateConfidence, number> = { low: 0, medium: 1, high: 2 };
  const numbered = res.items.filter((i) => i.kcal != null);
  if (numbered.length === 0) return "low";
  return numbered.reduce<EstimateConfidence>(
    (acc, i) => (order[i.confidence] < order[acc] ? i.confidence : acc),
    "high",
  );
}

/**
 * The dominant source kind backing the total, for the per-meal badge:
 *   - any estimate present → "estimate" (the meal is, in part, a 推定値)
 *   - else any label present → "label"
 *   - else (all 公式DB) → "db"
 * Computed over items that actually contributed a number.
 */
function dominantSourceKind(res: AnalyzeMealApiResponse): NutritionSourceKind {
  const numbered = res.items.filter((i) => i.kcal != null);
  if (numbered.some((i) => i.sourceKind === "estimate")) return "estimate";
  if (numbered.some((i) => i.sourceKind === "label")) return "label";
  return "db";
}

/**
 * Map the API response to a MealNutrition. ALWAYS returns numbers when ANY item
 * produced one (db OR label OR estimate) — the old "matched===0 → null →
 * 推定できませんでした" dead-end is gone, so real foods (supplements/packaged/
 * restaurant) now get a value. Returns null ONLY when nothing at all could be
 * sourced. The source kind + estimated flag are carried so the UI can mark a
 * total that includes estimates (never presenting an estimate as a DB figure).
 */
export function toMealNutrition(res: AnalyzeMealApiResponse): MealNutrition | null {
  if (res.numberedCount === 0) return null;
  // Prefer the official-DB source string when present; otherwise the first
  // sourced (label/estimate) string. The estimated flag tells the UI the truth.
  const dbSource = res.items.find((i) => i.matched && i.source)?.source;
  const anySource = res.items.find((i) => i.kcal != null && i.source)?.source;

  // Build the editable per-item breakdown (Phase 4). Only items that produced a
  // number become editable rows; db items carry their per-100g basis for exact
  // recompute, label/estimate items carry their proportional-scale anchor.
  const items: MealItem[] = res.items
    .filter((i) => i.kcal != null && i.sourceKind != null)
    .map((i) =>
      toMealItem({
        id: makeId(),
        name: i.name,
        grams: i.grams,
        kcal: i.kcal,
        proteinG: i.protein_g,
        fatG: i.fat_g,
        carbG: i.carb_g,
        sourceKind: i.sourceKind as NutritionSourceKind,
        source: i.source ?? undefined,
        confidence: i.confidence,
        foodCode: i.foodCode,
        basisPer100g: i.basisPer100g
          ? {
              foodCode: i.foodCode,
              kcal: i.basisPer100g.kcal,
              proteinG: i.basisPer100g.protein_g,
              fatG: i.basisPer100g.fat_g,
              carbG: i.basisPer100g.carb_g,
            }
          : undefined,
      }),
    );

  // Totals/flags are derived from the items when present (single source of truth
  // for the editable flow); fall back to the response totals otherwise.
  const derived = items.length > 0 ? itemsToNutrition(items) : null;
  return {
    calories: derived?.calories ?? res.totals.kcal,
    proteinG: derived?.proteinG ?? res.totals.protein_g,
    fatG: derived?.fatG ?? res.totals.fat_g,
    carbG: derived?.carbG ?? res.totals.carb_g,
    source: dbSource ?? anySource ?? undefined,
    confidence: summarizeConfidence(res),
    generatedBy: res.generatedBy,
    estimated: derived?.estimated ?? res.totalsIncludeEstimate,
    sourceKind: derived?.sourceKind ?? dominantSourceKind(res),
    items: items.length > 0 ? items : undefined,
  };
}

export interface AnalyzeMealOptions {
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Endpoint, overridable for tests. */
  endpoint?: string;
}

function readApiToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Whether an access key is configured in this browser. The key UNLOCKS the AI
 * features (photo/text analysis + 健康マン chat); without it those requests get
 * a 401. Used by the UI to surface a friendly "set your key" hint up front,
 * rather than only erroring after the user acts. SSR-safe (returns false).
 */
export function hasApiKey(): boolean {
  return readApiToken() !== "";
}

/**
 * Call the backend and return the grounded nutrition.
 * Throws on a network error, non-OK status, or when no dish matched the DB
 * (the caller treats every throw as "save record, allow re-analyze later").
 */
export async function analyzeMeal(
  input: AnalyzeMealInput,
  options: AnalyzeMealOptions = {},
): Promise<MealNutrition> {
  const hasImages =
    (input.imageBase64List && input.imageBase64List.length > 0) || !!input.imageBase64;
  if (!hasImages && !input.text?.trim()) {
    throw new Error("画像またはテキストが必要です");
  }
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? "/api/analyze-meal";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiToken = readApiToken();
  if (apiToken) headers["X-Health-App-Token"] = apiToken;

  const res = await doFetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      imageBase64: input.imageBase64,
      imageBase64List: input.imageBase64List,
      text: input.text,
    }),
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("アクセスキーを設定してください");
    }
    throw new Error(`解析に失敗しました (${res.status})`);
  }
  const data = (await res.json()) as AnalyzeMealApiResponse;
  const nutrition = toMealNutrition(data);
  if (!nutrition) {
    // Reaches here only when NOTHING could be sourced (no DB match, no readable
    // label, no estimate) — rare now that estimates always fill the gap.
    throw new Error("栄養値を取得できませんでした。あとで再試行できます。");
  }
  return nutrition;
}

/** Read a Blob as a base64 string (no data: prefix). Browser-only. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

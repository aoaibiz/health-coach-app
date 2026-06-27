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
  Micros,
  NutritionSourceKind,
} from "./types";
import { makeId } from "./date";
import { itemsToNutrition, setItemGrams, toMealItem } from "./mealItems";

export const API_TOKEN_STORAGE_KEY = "health-app:apiToken";

/**
 * Global name the SERVER injects the shared access token under, at request time,
 * into the served HTML (see server/index.mjs `injectAppToken`). When present it
 * means the user is already past the login gate (AuthGate) on a server that has
 * HEALTH_APP_TOKEN configured, so the AI features should be UNLOCKED with NO
 * manual key entry — the user has logged in; asking for an access key on top of
 * that is redundant (Ao feedback). It is the SAME shared value that every
 * browser already stored in localStorage and sent on every request, so injecting
 * it does not widen exposure.
 *
 * SECURITY: the token is read only on the client, used only as the
 * X-Health-App-Token request header, and never logged or echoed elsewhere. When
 * the env is unset the server omits the injection and the app falls back to the
 * manual-key path (honest), so nothing breaks.
 */
declare global {
  // eslint-disable-next-line no-var
  var __HEALTH_APP_TOKEN__: string | undefined;
}

/** The server-injected shared access token, or "" when absent. SSR-safe. */
function readInjectedToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const t = (window as { __HEALTH_APP_TOKEN__?: unknown }).__HEALTH_APP_TOKEN__;
    return typeof t === "string" ? t.trim() : "";
  } catch {
    return "";
  }
}

/**
 * The access token to send with AI requests: the SERVER-INJECTED shared token
 * takes precedence (logged-in user on a configured server → no manual key), then
 * the user's manually-stored key (advanced "use my own key" path / server with
 * the env unset). SSR-safe (returns ""). This is the single source of truth used
 * by analyzeMeal, chat, and hasApiKey so the unlock logic can never diverge.
 */
export function resolveApiToken(): string {
  return readInjectedToken() || readStoredToken();
}

/** Shape returned by the analyze-meal function (mirrors AnalyzeMealResponse). */
export interface AnalyzeMealApiResponse {
  items: Array<{
    name: string;
    grams: number;
    kcal: number | null;
    protein_g: number | null;
    fat_g: number | null;
    carb_g: number | null;
    /** Extra nutrients (「全栄養素を出す」) — NULLABLE (null = honestly unknown). */
    fiber_g?: number | null;
    sugar_g?: number | null;
    sodium_mg?: number | null;
    saturated_fat_g?: number | null;
    /** Vitamins/minerals (拡張①) — keyed bag, nullable per key; absent when none. */
    micros?: Micros;
    source: string | null;
    sourceKind: NutritionSourceKind | null;
    sourceLabel: string | null;
    estimated: boolean;
    confidence: EstimateConfidence;
    matched: boolean;
    /** Matched DB row food_code (db items only). */
    foodCode?: string;
    /** Matched DB row per-100g figures (db items only) — for exact client recompute. */
    basisPer100g?: {
      kcal: number;
      protein_g: number;
      fat_g: number;
      carb_g: number;
      fiber_g?: number | null;
      sugar_g?: number | null;
      sodium_mg?: number | null;
      saturated_fat_g?: number | null;
      /** Per-100g vitamins/minerals (拡張①) for exact recompute on edit. */
      micros?: Micros;
    };
  }>;
  totals: {
    kcal: number;
    /** PFC totals — NULLABLE: summed only over items that carry each macro; null
     *  when no numbered item did (a kcal-only estimate meal shows "—", never 0). */
    protein_g: number | null;
    fat_g: number | null;
    carb_g: number | null;
    fiber_g?: number | null;
    sugar_g?: number | null;
    sodium_mg?: number | null;
    saturated_fat_g?: number | null;
    /** Vitamin/mineral totals (拡張①) — nullable per key; absent when none. */
    micros?: Micros;
  };
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
        fiberG: i.fiber_g ?? null,
        sugarG: i.sugar_g ?? null,
        sodiumMg: i.sodium_mg ?? null,
        saturatedFatG: i.saturated_fat_g ?? null,
        micros: i.micros,
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
              fiberG: i.basisPer100g.fiber_g ?? null,
              sugarG: i.basisPer100g.sugar_g ?? null,
              sodiumMg: i.basisPer100g.sodium_mg ?? null,
              saturatedFatG: i.basisPer100g.saturated_fat_g ?? null,
              micros: i.basisPer100g.micros,
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
    // Extra nutrients (nullable): prefer the derived item-sum; else the response
    // totals (?? null when the field is absent — never a fabricated 0).
    fiberG: derived ? derived.fiberG : (res.totals.fiber_g ?? null),
    sugarG: derived ? derived.sugarG : (res.totals.sugar_g ?? null),
    sodiumMg: derived ? derived.sodiumMg : (res.totals.sodium_mg ?? null),
    saturatedFatG: derived ? derived.saturatedFatG : (res.totals.saturated_fat_g ?? null),
    // Vitamin/mineral totals (拡張①): derived item-sum when present, else response totals.
    micros: derived ? derived.micros : res.totals.micros,
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

/** Read ONLY the manually-stored key from localStorage (the user's own key).
 *  SSR-safe. Prefer resolveApiToken() for the actual request token. */
function readStoredToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Whether the AI features are UNLOCKED in this browser. True when EITHER the
 * server injected the shared token (logged-in user on a configured server → no
 * manual key needed) OR the user stored their own key. Used by the UI to decide
 * whether to show the friendly "set your key" hint. SSR-safe (returns false).
 */
export function hasApiKey(): boolean {
  return resolveApiToken() !== "";
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
  const apiToken = resolveApiToken();
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

/**
 * Honest AI estimate for a SINGLE manually-added item the bundled MEXT DB could
 * not match (e.g. a packaged drink / restaurant dish not in the table). Runs the
 * SAME grounded text-analysis path as 「✨ AI解析」 over just this item's name, so
 * the gap that used to show "栄養値を取得できませんでした" + 0 kcal is filled with a
 * real, clearly-LABELLED 推定値 (never 公式DB) instead of a dead-end zero.
 *
 * ANTI-FABRICATION: the number comes only from the grounded analysis (the model's
 * own labelled estimate, already sanity-bounded server-side); it is NEVER dressed
 * up as a DB value. The result keeps the caller's id + grams (scaled
 * proportionally from the estimate's anchor) so the row stays editable, and the
 * source stays "推定値" (sourceKind "estimate", low confidence). If the analysis
 * grounds the food to the DB after all (an alias the manual matcher missed), the
 * DB-sourced item is returned as-is.
 *
 * Returns null when no estimate could be obtained (offline, no access key, the
 * model declined, or it produced no usable number) — the caller then keeps the
 * existing honest no-number 推定値 row. NEVER throws: a failed estimate must not
 * break manual entry, which works without an access key.
 */
export async function estimateSingleItem(
  id: string,
  name: string,
  grams: number,
  options: AnalyzeMealOptions = {},
): Promise<MealItem | null> {
  const trimmed = name.trim();
  if (!trimmed || !hasApiKey()) return null;
  // Phrase it as a single-item meal so the analyzer returns one dish for it.
  const text = grams > 0 ? `${trimmed} ${grams}g` : trimmed;
  let nutrition: MealNutrition;
  try {
    nutrition = await analyzeMeal({ text }, options);
  } catch {
    return null; // offline / unauthed / declined — keep the honest no-number row.
  }
  const estimate = nutrition.items?.find((it) => it.kcal != null);
  if (!estimate) return null;
  // Re-key to the caller's id and re-scale to the grams they entered, keeping the
  // estimate's source label/anchor intact (proportional recompute for estimates,
  // exact DB recompute when the analysis grounded it to 公式DB).
  return setItemGrams({ ...estimate, id, name: trimmed }, grams > 0 ? grams : estimate.grams);
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

export interface GenerateMealImageInput {
  text: string;
}

export interface GenerateMealImageOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export interface GenerateMealImageResponse {
  imageBase64: string;
  mimeType: "image/png";
  generatedBy: string;
}

/** Generate an appetising meal-title illustration through the server's Codex subscription path. */
export async function generateMealImage(
  input: GenerateMealImageInput,
  options: GenerateMealImageOptions = {},
): Promise<Blob> {
  const text = input.text.trim();
  if (!text) throw new Error("料理名が必要です");

  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? "/api/generate-meal-image";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiToken = resolveApiToken();
  if (apiToken) headers["X-Health-App-Token"] = apiToken;

  const res = await doFetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("アクセスキーを設定してください");
    if (res.status === 503) throw new Error("画像生成は準備中です");
    throw new Error(`画像生成に失敗しました (${res.status})`);
  }
  const data = (await res.json()) as GenerateMealImageResponse;
  if (!data.imageBase64 || data.mimeType !== "image/png") {
    throw new Error("画像生成に失敗しました");
  }
  const bytes = Uint8Array.from(atob(data.imageBase64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: data.mimeType });
}


// POST /api/analyze-meal — thin BFF (PRD §5.2): proxy the LLM + ground every
// number to a clearly-labelled SOURCE. The provider tags each food db/label/
// estimate; for "db" the bundled MEXT DB supplies authoritative numbers, for
// label/estimate the model's (sanity-checked) numbers are used and explicitly
// marked 推定/参考. We ALWAYS return a number with its source — never the old
// "推定できませんでした" dead-end — and an estimate is never shown as a DB value.
//
// ┌─ TWO ACTIVE RUNTIME PATHS (same pure core) ─────────────────────────────┐
// │ 1. OUR / FAMILY: the Node backend in ../../server/index.mjs builds a       │
// │    CodexProvider (Codex CLI subscription — GPT-5.5 vision, NO paid API /    │
// │    NO API key) and calls the PURE handleAnalyzeMeal() below.               │
// │ 2. MEMBER SELF-HOST: a member's Cloudflare Pages deploy runs onRequestPost │
// │    below, which builds the member's OWN-KEY Gemini provider (via the       │
// │    worker-safe ../_llm/select-own) and calls the SAME handleAnalyzeMeal().  │
// │    This path is ACTIVE and worker-safe — it never imports the Node-only    │
// │    Codex providers.                                                        │
// └───────────────────────────────────────────────────────────────────────────┘
//
// Exports:
//   - handleAnalyzeMeal(request, provider): pure, framework-free — the shared
//     core used by BOTH the Node server and the member CF deploy (and unit tests
//     with a MockProvider, no network, no real key).
//   - onRequestPost: ACTIVE Cloudflare Pages entry for a member self-host deploy
//     (token-gated, own-key Gemini).

import {
  groundDishes,
  NUTRITION_SOURCE,
  type Confidence,
  type SourceKind,
} from "../_lib/ground";
import type { MealVisionProvider } from "../_llm/provider";
import type { Micros } from "../_lib/micros";
// A member's Cloudflare Pages (Workers) deploy is ALWAYS own-key, so the
// onRequestPost path uses the WORKER-SAFE selector (./select-own) that imports
// ONLY the fetch-native Gemini provider — never ../_llm/select, which references
// the Node-only Codex providers (node:child_process / node:fs) and would break
// the Workers bundle. The Node server keeps using ../_llm/select.
import { makeOwnKeyMealProvider, type ProviderEnv } from "../_llm/select-own";

/** ~9MB base64 ≈ ~6.7MB binary — generous cap for a client-downsized 1280px JPEG. */
const MAX_IMAGE_BASE64_CHARS = 9_000_000;
/** Per-meal cap on the number of photos sent in one analysis (bounds spawn args + latency). */
const MAX_IMAGES_PER_MEAL = 6;
/** Total base64 budget across ALL photos of one meal (bounds the request body + spawn). */
const MAX_TOTAL_IMAGE_BASE64_CHARS = 24_000_000;

export interface AnalyzeMealRequestBody {
  imageBase64?: string;
  /** Multiple base64 JPEGs for ONE meal (main + side + drink shots taken separately). */
  imageBase64List?: string[];
  text?: string;
}

export interface AnalyzedItem {
  name: string;
  grams: number;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carb_g: number | null;
  /** Additional nutrients (「全栄養素を出す」) — NULLABLE (null = honestly unknown). */
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  saturated_fat_g: number | null;
  /** Vitamins/minerals (拡張①) — keyed bag, nullable per key; absent when none. */
  micros?: Micros;
  source: string | null;
  /** Machine-readable source tag (db | label | estimate) driving the UI badge. */
  sourceKind: SourceKind | null;
  /** Human badge label (公式DB / ラベル値 / 推定値). */
  sourceLabel: string | null;
  /** True for any non-authoritative number (label/estimate) — UI marks it 推定. */
  estimated: boolean;
  confidence: Confidence;
  matched: boolean;
  /** Matched DB row food_code (db items only) — for traceability on the client. */
  foodCode?: string;
  /**
   * Matched DB row per-100g figures (db items only). Lets the client recompute
   * a db item EXACTLY from the official table on a portion edit (stays 公式DB).
   */
  basisPer100g?: {
    kcal: number;
    protein_g: number;
    fat_g: number;
    carb_g: number;
    fiber_g: number | null;
    sugar_g: number | null;
    sodium_mg: number | null;
    saturated_fat_g: number | null;
    /** Per-100g vitamins/minerals (拡張①) — for exact client recompute on edit. */
    micros?: Micros;
  };
}

export interface AnalyzeMealResponse {
  items: AnalyzedItem[];
  totals: {
    kcal: number;
    /** PFC totals — NULLABLE: summed only over items that carry each macro; null
     *  when no numbered item did (a kcal-only estimate meal shows "—", never 0). */
    protein_g: number | null;
    fat_g: number | null;
    carb_g: number | null;
    fiber_g: number | null;
    sugar_g: number | null;
    sodium_mg: number | null;
    saturated_fat_g: number | null;
    /** Vitamin/mineral day-portion totals (拡張①) — nullable per key; absent when none. */
    micros?: Micros;
  };
  generatedBy: string;
  /** Number of dishes that matched the official DB. */
  matchedCount: number;
  /** Number of items that produced ANY number (db + label + estimate). */
  numberedCount: number;
  /** True when the totals include at least one estimate/label (UI: ※推定を含む). */
  totalsIncludeEstimate: boolean;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * Core handler — pure and testable. Takes any MealVisionProvider so tests pass
 * a MockProvider (no network). Validates input, calls the provider, grounds the
 * dishes against the DB, and shapes the response. Never fabricates numbers.
 */
export async function handleAnalyzeMeal(
  request: Request,
  provider: MealVisionProvider,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  let body: AnalyzeMealRequestBody;
  try {
    body = (await request.json()) as AnalyzeMealRequestBody;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const text =
    typeof body.text === "string" && body.text.trim().length > 0
      ? body.text.trim()
      : undefined;

  // Collect the meal's image(s) into ONE ordered list: the multi-photo
  // `imageBase64List` plus any lone `imageBase64`, keeping only non-empty strings.
  // These are all photos of the SAME meal, analysed together as one.
  const imageBase64List: string[] = [];
  if (Array.isArray(body.imageBase64List)) {
    for (const b of body.imageBase64List) {
      if (typeof b === "string" && b.length > 0) imageBase64List.push(b);
    }
  }
  if (typeof body.imageBase64 === "string" && body.imageBase64.length > 0) {
    imageBase64List.push(body.imageBase64);
  }

  // Reject requests with neither image nor text.
  if (imageBase64List.length === 0 && !text) {
    return errorResponse("画像またはテキストが必要です", 400);
  }

  // Bound the photo count per meal (latency + spawn-arg sanity).
  if (imageBase64List.length > MAX_IMAGES_PER_MEAL) {
    return errorResponse("写真は一度に6枚までです", 413);
  }

  // Enforce a max size per image AND a total budget across all photos.
  let totalChars = 0;
  for (const b of imageBase64List) {
    if (b.length > MAX_IMAGE_BASE64_CHARS) {
      return errorResponse("画像が大きすぎます", 413);
    }
    totalChars += b.length;
  }
  if (totalChars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
    return errorResponse("画像の合計サイズが大きすぎます", 413);
  }

  let dishes;
  let generatedBy: string;
  try {
    const result = await provider.analyzeMeal({ imageBase64List, text });
    dishes = result.dishes;
    generatedBy = result.generatedBy;
  } catch {
    // Honest failure — the client keeps the meal record and can re-analyze.
    return errorResponse("解析に失敗しました。あとで再試行できます。", 502);
  }

  const grounded = groundDishes(dishes);

  const responseBody: AnalyzeMealResponse = {
    items: grounded.items.map((it) => ({
      name: it.matchedName ?? it.name,
      grams: it.grams,
      kcal: it.kcal,
      protein_g: it.protein_g,
      fat_g: it.fat_g,
      carb_g: it.carb_g,
      fiber_g: it.fiber_g,
      sugar_g: it.sugar_g,
      sodium_mg: it.sodium_mg,
      saturated_fat_g: it.saturated_fat_g,
      micros: it.micros,
      source: it.source,
      sourceKind: it.sourceKind,
      sourceLabel: it.sourceLabel,
      estimated: it.estimated,
      confidence: it.confidence,
      matched: it.matched,
      foodCode: it.matchedCode,
      basisPer100g: it.basisPer100g,
    })),
    totals: grounded.totals,
    generatedBy,
    matchedCount: grounded.matchedCount,
    numberedCount: grounded.numberedCount,
    totalsIncludeEstimate: grounded.totalsIncludeEstimate,
  };

  return json(responseBody);
}

// ---- Cloudflare Pages Functions entry (member self-host deploy) -----------
// This is the route a MEMBER's own Cloudflare Pages deploy runs. It selects the
// AI provider from the deploy's env via select.ts (AI_MODE=own + AI_PROVIDER=
// gemini → the member's own GEMINI_API_KEY; default → Codex), then calls the
// SAME pure handleAnalyzeMeal() the Node server uses, so the validation +
// grounding + anti-fabrication contract is identical.
//
// Access gate: mirror the Node server — the client must send X-Health-App-Token
// matching the deploy's APP_ACCESS_TOKEN env. If unset, the route fails closed
// (503) rather than running un-gated; on mismatch it returns 401. (Our/family
// instances use the Node server's HEALTH_APP_TOKEN; a member's CF deploy sets
// APP_ACCESS_TOKEN.)

interface PagesContext {
  request: Request;
  env: AnalyzeMealEnv;
}

/** The env a member's Pages deploy provides (provider selection + access gate). */
type AnalyzeMealEnv = ProviderEnv & { APP_ACCESS_TOKEN?: string };

/**
 * Constant-time-ish token comparison without Node crypto (CF Workers runtime).
 * Length check first (lengths are not secret), then a non-short-circuiting XOR
 * accumulate over the chars so the decision time doesn't leak the prefix.
 */
function tokensMatch(provided: string | null, expected: string): boolean {
  if (typeof provided !== "string") return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** ACTIVE CF Pages Functions handler — member self-host deploy entry. */
export async function onRequestPost(context: PagesContext): Promise<Response> {
  const expected = context.env.APP_ACCESS_TOKEN ?? "";
  if (!expected) {
    // Fail closed: no token configured → analysis unavailable (manual entry OK).
    return json(
      {
        error: "analysis_unavailable",
        message: "写真解析は準備中です。",
      },
      503,
    );
  }
  if (!tokensMatch(context.request.headers.get("x-health-app-token"), expected)) {
    return errorResponse("unauthorized", 401);
  }

  let provider: MealVisionProvider;
  try {
    provider = makeOwnKeyMealProvider(context.env);
  } catch {
    // Misconfigured AI_MODE/AI_PROVIDER → unavailable, never fabricates.
    return json(
      {
        error: "analysis_unavailable",
        message: "写真解析は準備中です。",
      },
      503,
    );
  }
  return handleAnalyzeMeal(context.request, provider);
}

/** Re-exported for callers that want to show the data source name. */
export { NUTRITION_SOURCE };

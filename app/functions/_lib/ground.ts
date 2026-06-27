// Grounding: turn an LLM-identified dish into a sourced kcal/PFC figure — and
// ALWAYS return a number, with the SOURCE clearly labelled.
//
// THIS IS THE ANTI-FABRICATION GUARD. Previously the rule was "hide what's not
// in the DB"; now it is "always show the source". Every number carries WHERE it
// came from, and an estimate is NEVER dressed up as an authoritative DB value.
//
// Three sources (each item is tagged with exactly one):
//   1. 公式DB ("db")    — standard whole foods (rice/meat/veg/fish). Grounded
//                         against the bundled MEXT table (per-100g × grams/100).
//                         AUTHORITATIVE. The LLM never supplies these numbers;
//                         the DB does. confidence=high.
//   2. ラベル値 ("label") — packaged/branded products whose photo shows a
//                         nutrition label. The model transcribes the label's
//                         kcal/PFC for the grams it estimated. confidence=medium.
//   3. 推定値 ("estimate")— not in the DB and no readable label. The model gives
//                         a general-knowledge estimate, explicitly marked 推定.
//                         confidence=low.
//
// SAFETY: a "db" food that does NOT match the DB falls back to the model's own
// estimate value (source 推定値) if it supplied one, else an honest no-data
// item — we never invent a DB figure. Negative or absurd values (e.g. one item
// over 10000 kcal) are rejected → honest no-data (anti-absurd-fabrication).

import {
  ENTRY_COUNT,
  NUTRITION_SOURCE,
  allEntries,
  lookupByNorm,
  type FoodEntry,
} from "../_data/lookup";
import { lookupAlias } from "./aliases";
import { normalizeFull, normalizeName } from "./normalize";
import { resolveStandardGrams } from "./standard-portions";
import {
  cleanMicros,
  scaleMicros,
  sumMicros,
  type MicroUnit,
  type Micros,
} from "./micros";

export type Confidence = "low" | "medium" | "high";

/** Which of the three sources backs a number. */
export type SourceKind = "db" | "label" | "estimate";

/** Display label per source — shown in the UI as a badge (anti-fabrication). */
export const SOURCE_LABEL: Record<SourceKind, string> = {
  db: "公式DB",
  label: "ラベル値",
  estimate: "推定値",
};

/**
 * Upper sanity bound for a SINGLE item's calories. A real single dish/product
 * tops out far below this; anything above is a hallucination/transcription error
 * and is rejected rather than shown. Pure cooking oil (~900kcal/100g) at 1kg is
 * ~9000kcal, so 10000 is comfortably above any plausible single item.
 */
export const MAX_ITEM_KCAL = 10000;
/** Loose per-gram ceilings for PFC sanity (>100g of pure macro per 100g食品 is impossible). */
const MAX_MACRO_PER_GRAM = 1; // 1 g macro per 1 g food = 100g/100g (physical max)

/**
 * A dish as identified by the LLM provider. For "db" foods the provider returns
 * name + grams ONLY (the DB supplies the numbers). For "label"/"estimate" foods
 * the provider ALSO returns kcal/PFC for that many grams (label = transcribed
 * from the photo, estimate = general-knowledge guess). Older callers that omit
 * `source` are treated as "db" (the historical behaviour).
 */
export interface IdentifiedDish {
  name: string;
  /** Estimated edible weight in grams. */
  grams: number;
  /** The provider's own confidence in the identification. */
  confidence?: Confidence;
  /** Where the numbers should come from. Defaults to "db" when omitted. */
  source?: SourceKind;
  /** Model-supplied numbers (label/estimate only); ignored for matched "db". */
  kcal?: number;
  protein_g?: number;
  fat_g?: number;
  carb_g?: number;
  /**
   * Additional model-supplied nutrients (label/estimate only; ignored for "db",
   * where the DB supplies them). All OPTIONAL — the model may not know them, in
   * which case they stay undefined (→ null downstream, never a fabricated 0).
   * 食物繊維(g) / 糖質(g) / 塩分=ナトリウム(mg) / 飽和脂肪(g)。
   */
  fiber_g?: number;
  sugar_g?: number;
  sodium_mg?: number;
  saturated_fat_g?: number;
  /**
   * Additional model-supplied vitamins/minerals (label/estimate only; ignored for
   * "db", where the DB supplies them). A keyed bag (functions/_lib/micros.ts) —
   * the model rarely reads these off a label, so it's usually absent → null.
   */
  micros?: Micros;
}

/** A single grounded line item. ALWAYS sourced; numbers may be null only when honestly unavailable. */
export interface GroundedItem {
  /** Display name (the LLM's name, or the matched DB name when matched). */
  name: string;
  grams: number;
  /** Whether a DB row was found. (Label/estimate items are matched:false.) */
  matched: boolean;
  /** kcal for the estimated grams — null only when no number could be sourced. */
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carb_g: number | null;
  /**
   * Additional nutrients for the estimated grams (「全栄養素を出す」). NULLABLE and
   * INDEPENDENT of kcal: a matched DB food may have kcal/PFC but no measured fiber
   * (→ fiber_g null), and the UI shows "—" for a null rather than a fabricated 0.
   * 食物繊維(g) / 糖質(g) / 塩分=ナトリウム(mg) / 飽和脂肪(g)。
   */
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  saturated_fat_g: number | null;
  /**
   * Vitamins/minerals for the estimated grams (拡張①). Same nullable contract as
   * the other extras: a keyed bag with null per unmeasured micro, or undefined
   * when the item carries no micro at all (UI shows "—"). Never a fabricated 0.
   */
  micros?: Micros;
  /** Data-source string for the numbers — null only when no number is available. */
  source: string | null;
  /** Machine-readable source tag driving the UI badge: db | label | estimate. */
  sourceKind: SourceKind | null;
  /** Human badge label (公式DB / ラベル値 / 推定値) — null when no number. */
  sourceLabel: string | null;
  /** True for any non-authoritative number (label/estimate) — UI marks it 推定/参考. */
  estimated: boolean;
  confidence: Confidence;
  /** The matched DB row's food_code, for traceability. */
  matchedCode?: string;
  /** The matched DB row's canonical Japanese name. */
  matchedName?: string;
  /**
   * The matched DB row's per-100g figures (db items only). Carried so the client
   * can recompute EXACTLY from the official table when the user edits the
   * portion — the number stays 公式DB, never a scaled model figure.
   */
  basisPer100g?: {
    kcal: number;
    protein_g: number;
    fat_g: number;
    carb_g: number;
    /** Nullable extra nutrients per 100g (null when the DB row doesn't measure them). */
    fiber_g: number | null;
    sugar_g: number | null;
    sodium_mg: number | null;
    /** Saturated fat is NOT in the bundled table → always null for db items. */
    saturated_fat_g: number | null;
    /** Per-100g vitamins/minerals (拡張①), nullable per key; absent when the row
     *  measures none. Carried so the client recomputes micros exactly on edit. */
    micros?: Micros;
  };
}

export interface GroundedTotals {
  kcal: number;
  /**
   * PFC totals — NULLABLE (anti-fabrication). Summed ONLY over the numbered items
   * that actually carry that macro (a kcal-only estimate item contributes its kcal
   * but NOT a fake 0 protein). null when NO numbered item carried that macro (so a
   * meal of kcal-only estimates shows protein "—", never a fabricated 0g). db
   * items always carry PFC, so a normal meal still has real numbers here.
   */
  protein_g: number | null;
  fat_g: number | null;
  carb_g: number | null;
  /**
   * Extra-nutrient totals — NULLABLE. A total is null when NO numbered item
   * contributed that nutrient (so we never show "0g fiber" for a meal whose foods
   * simply have no fiber figure). When at least one item has it, the total is the
   * sum over the items that DO (items missing it just don't add — honest partial).
   */
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  saturated_fat_g: number | null;
  /**
   * Vitamin/mineral totals (拡張①). Per key: null when NO numbered item carried
   * that micro, else the sum over items that DO. undefined when no item carried
   * any micro (so the field is omitted; no fabricated "0µg ビタミンC").
   */
  micros?: Micros;
}

export interface GroundingResult {
  items: GroundedItem[];
  totals: GroundedTotals;
  /** Count of items with a DB match. */
  matchedCount: number;
  /** Count of items that produced ANY number (db OR label OR estimate). */
  numberedCount: number;
  /** True when at least one totalled item is a non-authoritative estimate/label. */
  totalsIncludeEstimate: boolean;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampGrams(grams: number): number {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  // Guard against an absurd portion (10kg) the LLM might hallucinate.
  return Math.min(grams, 10000);
}

function tokens(s: string): string[] {
  return s.split(" ").filter((t) => t.length > 0);
}

type MatchMethod = "alias" | "exact" | "single-token" | "fuzzy" | "cooking-variant";

interface FoodMatch {
  food: FoodEntry;
  method: MatchMethod;
  confidence: Confidence;
}

const GENERIC_TOKENS = new Set([
  "こめ",
  "米",
  "むね",
  "もも",
  "生",
  "焼き",
  "ゆで",
  "皮つき",
  "皮なし",
  "食品",
  "料理",
]);

function effectiveTokens(rawTokens: string[]): string[] {
  return rawTokens.filter((t) => t.length >= 2 && !GENERIC_TOKENS.has(t));
}

/**
 * Minimum length (in Unicode code points, ~= JP characters) for a single-token
 * query to be eligible for the substring (CONTAINS) match in step 2.5. Two-char
 * fragments (むね/こめ/もも) and one-char generics (生/米) are far too broad —
 * they collide with dozens of unrelated DB rows — so they stay blocked here and
 * must be grounded via an alias or a multi-token exact/fuzzy match instead.
 */
const SINGLE_TOKEN_MIN_CHARS = 3;

/** Code-point length, so surrogate-pair-free JP counting is accurate. */
function charLength(s: string): number {
  return [...s].length;
}

/**
 * A single-token query is "specific enough" to drive a substring match only
 * when it is at least SINGLE_TOKEN_MIN_CHARS long and not a known generic token.
 * (Aliases are matched earlier, in step 1, so they never reach this guard.)
 */
function isSpecificSingleToken(token: string): boolean {
  return charLength(token) >= SINGLE_TOKEN_MIN_CHARS && !GENERIC_TOKENS.has(token);
}

// Derivative / processed PRODUCTS made FROM the food rather than the food
// itself (しいたけ→しいたけだし, トマト→トマトケチャップ, ぶどう→ぶどう糖). These
// carry no cooking-state word, so without this guard a short product name could
// out-rank the plain "…生" row. Pushed far down so the substring match never
// lands on a condiment/juice/sugar when the user just named the raw food.
const DERIVATIVE_PRODUCT_PATTERNS: RegExp[] = [
  /だし|糖|でん粉|でんぷん|油\b|油$/, // stock / sugar / starch / oil
  /ジュース|飲料|果汁|酢|ピューレー|ペースト|ケチャップ|ソース|ジャム|シロップ/, // condiments / drinks
  /パン|ケーキ|菓子|あめ|豆\b|豆$/, // baked / confectionery / bean products
];

// Cooking/processing forms that make a row a SPECIAL preparation rather than the
// plain food the user named. For a bare single-token query ("さつまいも") we want
// the most basic form, so we penalize these. Ordered by how far they are from
// "plain": deep-fried/candied/dried/canned are worst.
const SPECIAL_FORM_PATTERNS: RegExp[] = [
  /天ぷら|フライ|から揚げ|唐揚げ|素揚げ|油いため|ソテー|いため/, // fried / sautéed
  /砂糖|甘酢|味付け|つくだ煮|佃煮|あめ煮|甘煮|漬|キムチ/, // seasoned / pickled
  /缶詰|瓶詰|レトルト|冷凍|チルド/, // preserved / packaged
  /乾|干し|切干|蒸し切干|フレーク|フラワー|グリッツ|ミール/, // dried / milled
];

/**
 * Rank substring-match candidates so a bare single-token query lands on the most
 * BASIC form. Lower score = more basic = preferred. Tie-break: lower food_code.
 *   raw (生) < steamed/boiled (蒸し/ゆで/水煮) < grilled (焼き) << special forms
 *   << derivative products. 皮なし preferred over 皮つき for an equal pair.
 */
function basicFormScore(name: string): number {
  let score = 0;
  // Derivative products (だし/糖/ジュース…) are pushed furthest down so a raw
  // food never grounds to a condiment/drink/sugar made from it.
  if (DERIVATIVE_PRODUCT_PATTERNS.some((re) => re.test(name))) score += 10000;
  // Special/processed forms are pushed far down (each matched class adds a lot).
  SPECIAL_FORM_PATTERNS.forEach((re, i) => {
    if (re.test(name)) score += 100 * (i + 1);
  });
  // Among plain cooking states: 生 (0) < 蒸し/ゆで/水煮 (10) < 焼き (20).
  if (/焼き/.test(name)) score += 20;
  else if (/蒸し|ゆで|湯通し|水煮/.test(name)) score += 10;
  // A row that explicitly says 生 is the canonical basic form — give it an edge
  // over an unqualified row of the same class (so "…生" wins ties cleanly).
  if (/生/.test(name)) score -= 1;
  // Prefer 皮なし over 皮つき (skin-on slightly less "plain" to eat as-named).
  if (/皮つき/.test(name)) score += 2;
  // Prefer the shorter (less-qualified) name as a final nudge toward the basic row.
  score += charLength(name) * 0.01;
  return score;
}

/**
 * Single-token substring match: rows whose normalized name CONTAINS the token.
 * Used only for a specific-enough single-token query (see isSpecificSingleToken)
 * that had no alias and no exact match — e.g. "さつまいも" → the verbose DB row
 * "さつまいも 塊根 皮なし 生". Returns the most basic form, or null if none.
 */
function findSingleTokenContains(token: string): FoodEntry | null {
  const candidates: FoodEntry[] = [];
  for (const e of allEntries()) {
    if (e.name_norm.includes(token)) candidates.push(e);
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((best, e) => {
    const sBest = basicFormScore(best.name_norm);
    const sE = basicFormScore(e.name_norm);
    if (sE < sBest) return e;
    if (sE === sBest && e.food_code < best.food_code) return e;
    return best;
  });
}

// ---------------------------------------------------------------------------
// CONSERVATIVE COOKING-METHOD NORMALIZER (anti-fabrication is paramount)
//
// A query like "焼きさつまいも" / "蒸しさつまいも" names a single whole food plus a
// cooking method. The plain food ("さつまいも") matches the DB, and the DB also has
// the prepared variant ("…焼き", "…蒸し"). This pass resolves such names to the
// CORRECT prepared row — but ONLY when it is provably safe, never by blind
// stripping. (Explicit curated aliases in aliases.ts cover the very common ones;
// this generalizes the same idea to other clear single-ingredient + method names
// where the DB has the variant.)
//
// SAFETY: a COMPOUND DISH whose name merely STARTS with a cooking word is NOT
// "method + ingredient" — 焼きそば(yakisoba)≠そば, 焼き肉(yakiniku)≠肉,
// 焼き鳥(yakitori), たこ焼き, お好み焼き, 焼きおにぎり… Stripping the method there
// and matching the base would be a WRONG match. We refuse to strip when:
//   (a) the FULL name is a known compound dish (denylist), OR
//   (b) the remainder is not itself a CONFIDENT base match (alias / specific
//       single-token DB hit) — a generic 1-2 char remainder (肉/鳥/芋) is rejected.
// When the base IS confident, we land on a sibling row by SUBSTITUTING the base
// row's own trailing cooking-state token with the requested method (a structural
// swap that can only ever reach a variant of the SAME food, never a different
// food). If no such sibling exists we return null here and let the caller fall
// back to the honest 推定 row — we never force a match.
// ---------------------------------------------------------------------------

/** Cooking-method prefixes we will consider stripping, longest-first so 茹で is
 *  tried before a hypothetical 茹. Each maps to the DB cooking-state word used in
 *  row names (the MEXT table writes 茹で/ゆで as "ゆで", 揚げ as "素揚げ", etc.). */
const COOKING_PREFIXES: Array<{ prefix: string; dbWord: string }> = [
  { prefix: "焼き", dbWord: "焼き" },
  { prefix: "焼", dbWord: "焼き" },
  { prefix: "蒸し", dbWord: "蒸し" },
  { prefix: "蒸", dbWord: "蒸し" },
  { prefix: "茹で", dbWord: "ゆで" },
  { prefix: "ゆで", dbWord: "ゆで" },
  { prefix: "ボイル", dbWord: "ゆで" },
];

/** DB cooking-state tokens that may appear as the LAST token of a base row name
 *  and be swapped for the requested method. Listed so we only ever substitute a
 *  genuine cooking-state word (never, say, 皮なし or a species name). */
const DB_COOKING_STATE_TOKENS = new Set(["生", "蒸し", "ゆで", "焼き", "水煮", "湯通し"]);

/**
 * Compound dishes whose NAME starts with a cooking word but which are NOT
 * "method + single ingredient". These must never be stripped to a base food.
 * Matched on the fully normalized query name. (焼きそば/焼き肉/お好み焼き are also
 * curated aliases, so they ground correctly even without this list; the denylist
 * is defense-in-depth for compound dishes that have no alias yet.)
 */
const COMPOUND_DISH_DENYLIST = new Set(
  [
    "焼きそば",
    "焼そば",
    "ソース焼きそば",
    "焼き肉",
    "焼肉",
    "焼き鳥",
    "焼鳥",
    "やきとり",
    "焼きおにぎり",
    "焼おにぎり",
    "焼きうどん",
    "焼うどん",
    "焼き飯",
    "焼飯",
    "焼きめし",
    "焼きビーフン",
    "お好み焼き",
    "たこ焼き",
    "たこ焼",
    "もんじゃ焼き",
    "今川焼き",
    "どら焼き",
    "たい焼き",
    "鯛焼き",
    "卵焼き",
    "玉子焼き",
    "だし巻き卵",
    "厚焼き卵",
    "蒸しパン",
    "茶碗蒸し",
    "蒸し餃子",
    "蒸ししゅうまい",
    "焼き餃子",
    "ゆで餃子",
  ].map((s) => normalizeName(s)),
);

/**
 * Resolve a cooking-method-prefixed single-ingredient name to the correct
 * prepared DB row, or null if it cannot be done SAFELY. See the block comment.
 *
 * `baseMatcher` is the recursive entry into findFoodMatch (alias/exact/single-
 * token/fuzzy) used to confirm the remainder is a real, confident food — passed
 * in to avoid a forward reference.
 */
function findCookingVariant(
  name: string,
  baseMatcher: (n: string) => FoodMatch | null,
): FoodMatch | null {
  const queryNorm = normalizeName(name);
  if (!queryNorm) return null;
  // (a) Never strip a known compound dish.
  if (COMPOUND_DISH_DENYLIST.has(queryNorm)) return null;
  // A multi-token query is handled by exact/fuzzy already; this pass targets the
  // glued "焼きさつまいも" form (one token, no spaces).
  if (queryNorm.includes(" ")) return null;

  for (const { prefix, dbWord } of COOKING_PREFIXES) {
    if (!queryNorm.startsWith(prefix)) continue;
    const baseName = queryNorm.slice(prefix.length);
    // (b) Remainder must be a substantial, CONFIDENT base food. A 1-char
    //     remainder (芋/魚) is too generic; require >=2 chars AND a real match
    //     that is NOT itself a generic-meat-style "low" representative? No — we
    //     allow alias/exact/single-token (all >= medium for specifics). A bare
    //     generic remainder simply won't match and is rejected here.
    if (charLength(baseName) < 2) return null;
    const baseMatch = baseMatcher(baseName);
    if (!baseMatch) return null;
    // Only trust base matches that are themselves specific (alias / exact /
    // single-token substring). A "fuzzy" base is too loose to safely re-cook.
    if (baseMatch.method === "fuzzy") return null;

    // Land on the sibling row by swapping the base row's trailing cooking-state
    // token for the requested method — a structural swap confined to the SAME
    // food. e.g. base "さつまいも 塊根 皮なし 生" + 焼き → "…皮なし 焼き" (02008).
    const baseTokens = tokens(baseMatch.food.name_norm);
    const last = baseTokens[baseTokens.length - 1];
    if (baseTokens.length >= 2 && DB_COOKING_STATE_TOKENS.has(last)) {
      const variantNorm = baseTokens.slice(0, -1).concat(dbWord).join(" ");
      const variantRows = lookupByNorm(variantNorm);
      if (variantRows.length === 1) {
        // Confidence: never higher than the base match; cap at medium because
        // the method-resolution is heuristic (not a curated alias).
        const confidence: Confidence = baseMatch.confidence === "low" ? "low" : "medium";
        return { food: variantRows[0], method: "cooking-variant", confidence };
      }
    }
    // The base food has no such prepared variant in the DB → don't force it.
    // (Returning null here keeps "焼き<food with no 焼き row>" honest: it falls to
    //  the model's 推定, rather than mislabelling the plain row as the cooked one.)
    return null;
  }
  return null;
}

/**
 * Tie-breaker among rows the query already matched. Prefers the row whose
 * *full* name (brackets kept — e.g. ［水稲めし］ vs ［水稲穀粒］) shares the most
 * tokens with the query, so a query mentioning "めし"/"ごはん" lands on cooked
 * rice rather than the raw grain. Deterministic fallback: lowest food_code.
 */
function disambiguate(queryFullTokens: string[], rows: FoodEntry[]): FoodEntry {
  const cooked = rows
    .filter((e) => /めし|ゆで|焼き|ソテー|調理後|水煮/.test(e.name_full))
    .sort((a, b) => a.food_code.localeCompare(b.food_code));
  const raw = rows.some((e) => /穀粒|生|乾/.test(e.name_full));
  const queryMentionsRaw = queryFullTokens.some((t) => /穀粒|生|乾/.test(t));
  const queryMentionsCooked = queryFullTokens.some((t) => /めし|ごはん|飯|ゆで|焼き|ソテー|調理後|水煮/.test(t));
  if (!queryMentionsRaw && !queryMentionsCooked && raw && cooked.length > 0) {
    return cooked[0];
  }

  let best = rows[0];
  let bestScore = -1;
  for (const e of rows) {
    const full = normalizeFull(e.name_jp);
    // A query word counts when it appears anywhere in the candidate's full
    // name — bracketed or not — so "めし"/"ごはん" matches ［水稲めし］ and lands
    // on cooked rice (156) rather than the raw grain (342).
    let score = 0;
    for (const t of queryFullTokens) {
      if (t.length >= 2 && full.includes(t)) score += 1;
    }
    // Tie → lower food_code wins (stable, deterministic).
    if (score > bestScore || (score === bestScore && e.food_code < best.food_code)) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

/**
 * Pick the single best DB row for a dish name.
 *  1. exact alias match (verified food_code);
 *  2. exact name_norm match (one row → use it; collisions → token-disambiguate);
 *  2.5. specific single-token substring match (e.g. "さつまいも" → the verbose DB
 *       row), guarded by isSpecificSingleToken so generic 2-char fragments stay out;
 *  3. strong fuzzy match only when the query has at least two effective tokens;
 *  4. otherwise null (unmatched — never fabricated).
 */
function findFoodMatch(name: string): FoodMatch | null {
  const queryNorm = normalizeName(name);
  if (!queryNorm) return null;
  const queryTokens = tokens(queryNorm);
  const queryEffectiveTokens = effectiveTokens(queryTokens);
  const queryFullTokens = tokens(normalizeFull(name));

  // 1. Exact alias match.
  const alias = lookupAlias(name);
  if (alias) return { food: alias.food, method: "alias", confidence: alias.confidence };

  // 2. Exact normalized match.
  const exact = lookupByNorm(name);
  if (exact.length === 1) return { food: exact[0], method: "exact", confidence: "high" };
  if (exact.length > 1) {
    return { food: disambiguate(queryFullTokens, exact), method: "exact", confidence: "high" };
  }

  // 2.4. COMPOUND-DISH GUARD (anti-fabrication, runs BEFORE the substring match).
  //      A known compound dish (焼き肉/焼き鳥/たこ焼き…) that was NOT resolved by an
  //      alias or exact row must NOT be grabbed by the single-token substring
  //      matcher below — that would land it on a SAUCE/derivative row (焼き肉 →
  //      17113 焼き肉のたれ) or some unrelated containing-row, i.e. a confidently
  //      WRONG food. We bail out of findFoodMatch here so it falls through to the
  //      honest 推定/null fallback in groundDish. Compound dishes that DO have a
  //      genuine DB row are handled by an explicit alias in aliases.ts (matched in
  //      step 1, so they never reach this guard). This is the earlier twin of the
  //      step-2.7 denylist in findCookingVariant: alias + exact still win first.
  if (COMPOUND_DISH_DENYLIST.has(queryNorm)) return null;

  // 2.5. Specific single-token substring match. A bare, specific-enough token
  //      ("さつまいも") matches the verbose DB name "さつまいも 塊根 皮なし 生".
  //      Guarded so generic 2-char fragments (むね/こめ/もも) never reach it —
  //      those must come through an alias or a multi-token match. Picks the most
  //      basic form (生 over 焼き/天ぷら); medium confidence (one token only).
  if (queryTokens.length === 1 && isSpecificSingleToken(queryTokens[0])) {
    const single = findSingleTokenContains(queryTokens[0]);
    if (single) return { food: single, method: "single-token", confidence: "medium" };
  }

  // 2.7. Conservative cooking-method normalizer. For a glued single-token name
  //      like "焼きさつまいも"/"蒸しさつまいも" (not an alias, not an exact row),
  //      strip a leading cooking method ONLY when (a) it isn't a compound-dish
  //      (denylist: 焼きそば/焼き肉/たこ焼き…) and (b) the remainder is a CONFIDENT
  //      base food; then land on that food's matching prepared variant via a
  //      structural token swap. Never forces a cross-food match.
  const cooking = findCookingVariant(name, findFoodMatch);
  if (cooking) return cooking;

  // 3. Strong fuzzy match. Single-token and generic-token queries are not
  //    eligible; they must be aliases or exact DB names to avoid false grounding.
  if (queryTokens.length < 2 || queryEffectiveTokens.length < 2) return null;
  let bestRows: FoodEntry[] = [];
  let bestScore = 0;
  let bestNormLen = Infinity;
  for (const e of allEntries()) {
    const dbTokens = tokens(e.name_norm);
    const dbEffectiveTokens = effectiveTokens(dbTokens);
    if (dbEffectiveTokens.length === 0) continue;
    let shared = 0;
    for (const t of dbEffectiveTokens) if (queryEffectiveTokens.includes(t)) shared += 1;
    if (shared < 2) continue;
    const dbCoverage = shared / dbEffectiveTokens.length;
    const queryCoverage = shared / queryEffectiveTokens.length;
    const strongCoverage =
      (queryCoverage >= 0.8 && dbCoverage >= 0.5) ||
      (dbCoverage >= 0.8 && queryCoverage >= 0.5);
    if (!strongCoverage) continue;
    // Prefer more shared tokens; tie-break toward the shorter (more specific)
    // DB name so we don't over-match a long compound entry.
    if (
      shared > bestScore ||
      (shared === bestScore && e.name_norm.length < bestNormLen)
    ) {
      bestScore = shared;
      bestNormLen = e.name_norm.length;
      bestRows = [e];
    } else if (shared === bestScore && e.name_norm.length === bestNormLen) {
      bestRows.push(e);
    }
  }
  if (bestRows.length === 0) return null;
  const food = bestRows.length === 1 ? bestRows[0] : disambiguate(queryFullTokens, bestRows);
  return { food, method: "fuzzy", confidence: "low" };
}

export function findFood(name: string): FoodEntry | null {
  return findFoodMatch(name)?.food ?? null;
}

/**
 * A non-negative finite number, or null. Used to sanitise model-supplied
 * label/estimate numbers before we ever show them.
 */
function cleanNumber(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Anti-absurd-value guard for model-supplied (label/estimate) numbers. Rejects
 * negatives, non-finite, an impossible per-gram macro density, or an item over
 * MAX_ITEM_KCAL. On rejection returns null (→ honest no-data) so a hallucinated
 * "50000 kcal" or a negative figure is never surfaced.
 */
interface ModelNutrition {
  kcal: number;
  /**
   * PFC stay NULLABLE (anti-fabrication): a label/estimate item may carry only a
   * kcal figure (the model couldn't read the macros off the label / didn't state
   * them). A MISSING macro is kept null — never coerced to a fabricated 0 — so the
   * UI shows "—" and the meal/day totals sum it only over items that actually have
   * it (same NULL-not-0 discipline as fiber/sugar/sodium and micros). An
   * out-of-range macro is dropped to null (not the whole item).
   */
  protein_g: number | null;
  fat_g: number | null;
  carb_g: number | null;
  /**
   * Extra nutrients stay NULLABLE too: a missing fiber/sugar/sodium/saturated
   * stays null so we never fabricate a 0 the model didn't state. An out-of-range
   * extra is dropped to null (not the whole item) so one absurd fiber figure can't
   * void an otherwise-good estimate.
   */
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
  saturated_fat_g: number | null;
  /** Vitamins/minerals (拡張①) — keyed bag, nullable per key; undefined when none. */
  micros?: Micros;
}

/**
 * A generous physical ceiling for a model-supplied micro figure, per portion, by
 * unit. A single food/serving can't realistically exceed a few hundred mg of a
 * mineral or a few thousand µg of a vitamin per gram; we cap WAY above any real
 * value, since the purpose is only to reject an absurd hallucination, not to
 * second-guess a plausible figure. Out-of-range → dropped to null (not a reject
 * of the whole item) by cleanMicros.
 */
function microCeil(grams: number): (unit: MicroUnit) => number {
  const g = Math.max(grams, 1);
  return (unit) => (unit === "mg" ? g * 1000 : g * 1_000_000);
}

function sanitizeModelNutrition(
  dish: IdentifiedDish,
  grams: number,
): ModelNutrition | null {
  const kcal = cleanNumber(dish.kcal);
  const protein_g = cleanNumber(dish.protein_g);
  const fat_g = cleanNumber(dish.fat_g);
  const carb_g = cleanNumber(dish.carb_g);
  // Need at least a kcal figure to show anything useful.
  if (kcal === null) return null;
  if (kcal > MAX_ITEM_KCAL) return null;
  // PFC are optional but, when present, must be physically plausible for the
  // portion (no more macro grams than the food itself weighs).
  const gramsCeil = Math.max(grams, 1) * MAX_MACRO_PER_GRAM;
  for (const m of [protein_g, fat_g, carb_g]) {
    if (m !== null && m > gramsCeil) return null;
  }
  // Extra gram-nutrients (fiber/sugar/saturated): same physical ceiling, but an
  // over-range value is DROPPED to null (not a hard reject) — the macro PFC are
  // the load-bearing figures, the extras are best-effort. Sodium is in mg, so it
  // has its own (very generous) ceiling: even very salty food is < a few g/100g
  // ≈ a few thousand mg; cap at the portion grams × 100 mg/g (1000mg per 10g).
  const extraGCeil = gramsCeil; // grams of fiber/sugar/satfat can't exceed the food's weight
  const sodiumCeil = Math.max(grams, 1) * 100; // mg ceiling — far above any real food
  const cleanExtra = (v: number | null, ceil: number): number | null =>
    v === null || v > ceil ? null : round1(v);
  return {
    kcal: round1(kcal),
    // A MISSING macro stays null (NOT a fabricated 0) — anti-fabrication. The
    // totals sum each macro only over items that actually carry it (see
    // groundDishes), so an unmeasured macro shows "—" and never pollutes a sum.
    protein_g: protein_g === null ? null : round1(protein_g),
    fat_g: fat_g === null ? null : round1(fat_g),
    carb_g: carb_g === null ? null : round1(carb_g),
    fiber_g: cleanExtra(cleanNumber(dish.fiber_g), extraGCeil),
    sugar_g: cleanExtra(cleanNumber(dish.sugar_g), extraGCeil),
    sodium_mg: cleanExtra(cleanNumber(dish.sodium_mg), sodiumCeil),
    saturated_fat_g: cleanExtra(cleanNumber(dish.saturated_fat_g), extraGCeil),
    // Vitamins/minerals from the model (rare on a label) — sanitised per unit.
    micros: cleanMicros(dish.micros, microCeil(grams)),
  };
}

/** An honest "no number available" item (no source could produce a figure). */
function noDataItem(name: string, grams: number): GroundedItem {
  return {
    name,
    grams,
    matched: false,
    kcal: null,
    protein_g: null,
    fat_g: null,
    carb_g: null,
    fiber_g: null,
    sugar_g: null,
    sodium_mg: null,
    saturated_fat_g: null,
    source: null,
    sourceKind: null,
    sourceLabel: null,
    estimated: false,
    confidence: "low",
  };
}

/** A label/estimate item built from sanitised model numbers (never authoritative). */
function modelSourcedItem(
  name: string,
  grams: number,
  kind: "label" | "estimate",
  nums: ModelNutrition,
): GroundedItem {
  return {
    name,
    grams,
    matched: false, // not a DB match — its number is medium/low, not authoritative
    kcal: nums.kcal,
    protein_g: nums.protein_g,
    fat_g: nums.fat_g,
    carb_g: nums.carb_g,
    fiber_g: nums.fiber_g,
    sugar_g: nums.sugar_g,
    sodium_mg: nums.sodium_mg,
    saturated_fat_g: nums.saturated_fat_g,
    micros: nums.micros,
    source: SOURCE_LABEL[kind],
    sourceKind: kind,
    sourceLabel: SOURCE_LABEL[kind],
    estimated: true,
    confidence: kind === "label" ? "medium" : "low",
  };
}

/**
 * Ground one dish to a sourced number. Routing by `dish.source`:
 *   - "db" (default): DB lookup. Match → authoritative 公式DB (high). No match →
 *     fall back to the model's own estimate value if present, else honest no-data.
 *   - "label"/"estimate": use the model's sanitised numbers, tagged ラベル値
 *     (medium) / 推定値 (low). Absurd/negative values are rejected → no-data.
 */
export function groundDish(dish: IdentifiedDish): GroundedItem {
  // Resolve the portion BEFORE clamping the upper bound: a stated amount (>0) is
  // kept verbatim, a missing/zero amount falls back to THIS food's SHARED standard
  // portion (functions/_lib/standard-portions) — the SAME table the chat MEAL_LOG
  // grounding uses, so an unstated コーヒー lands on 200g on BOTH paths → the SAME
  // kcal (fixes the 8 vs 10 divergence). Then clampGrams bounds an absurd value.
  const grams = clampGrams(resolveStandardGrams(dish.name, dish.grams).grams);
  const source: SourceKind = dish.source ?? "db";

  // ---- label / estimate: the model supplies the numbers (not the DB) --------
  if (source === "label" || source === "estimate") {
    const nums = sanitizeModelNutrition(dish, grams);
    if (!nums) return noDataItem(dish.name, grams);
    return modelSourcedItem(dish.name, grams, source, nums);
  }

  // ---- db: authoritative DB grounding ---------------------------------------
  const match = findFoodMatch(dish.name);
  const food = match?.food;

  if (food) {
    const factor = grams / 100;
    // Extra nutrients are NULLABLE on the DB row: scale to the portion only when
    // the table measured them, else carry null (never a fabricated 0). Saturated
    // fat is not in the bundled table → always null for a 公式DB item.
    const scaleOrNull = (per100: number | null): number | null =>
      per100 === null ? null : round1(per100 * factor);
    return {
      name: dish.name,
      grams,
      matched: true,
      kcal: round1(food.kcal * factor),
      protein_g: round1(food.protein_g * factor),
      fat_g: round1(food.fat_g * factor),
      carb_g: round1(food.carb_g * factor),
      fiber_g: scaleOrNull(food.fiber_g),
      sugar_g: scaleOrNull(food.sugar_g),
      sodium_mg: scaleOrNull(food.sodium_mg),
      saturated_fat_g: null,
      // Vitamins/minerals scaled to the portion (nullable per key; absent → undefined).
      micros: scaleMicros(food.micros, factor),
      source: NUTRITION_SOURCE,
      sourceKind: "db",
      sourceLabel: SOURCE_LABEL.db,
      estimated: false,
      confidence: match.confidence,
      matchedCode: food.food_code,
      matchedName: food.name_jp,
      // Per-100g basis so the client recomputes exactly from the DB on edit.
      basisPer100g: {
        kcal: food.kcal,
        protein_g: food.protein_g,
        fat_g: food.fat_g,
        carb_g: food.carb_g,
        fiber_g: food.fiber_g,
        sugar_g: food.sugar_g,
        sodium_mg: food.sodium_mg,
        saturated_fat_g: null,
        // Per-100g micros carried so the client recomputes exactly on edit.
        micros: food.micros ?? undefined,
      },
    };
  }

  // A "db" food that the DB can't match: fall back to the model's estimate value
  // (clearly marked 推定値) if it supplied one — so real foods still get a number
  // instead of the old "推定できませんでした" dead-end. We NEVER invent a DB figure.
  const nums = sanitizeModelNutrition(dish, grams);
  if (nums) return modelSourcedItem(dish.name, grams, "estimate", nums);
  return noDataItem(dish.name, grams);
}

/**
 * Sum one nullable extra-nutrient across items: null when NO item carried it (so
 * a meal of foods with no fiber figure shows fiber "—", not a fake 0), else the
 * sum over the items that DO have it (items missing it just don't add — an honest
 * partial total). Mirrors the same rule client-side in mealItems.itemsToNutrition.
 */
function sumNullable(items: GroundedItem[], pick: (i: GroundedItem) => number | null): number | null {
  const present = items.map(pick).filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return round1(present.reduce((a, b) => a + b, 0));
}

/** Ground a list of dishes; total EVERY numbered item (db + label + estimate). */
export function groundDishes(dishes: IdentifiedDish[]): GroundingResult {
  const items = dishes.map(groundDish);
  const numbered = items.filter((it) => it.kcal !== null);
  // kcal is summed over every numbered item (all have it by definition). PFC are
  // summed ONLY over items that actually carry each macro (sumNullable), so a
  // kcal-only estimate item adds its kcal but never a fabricated 0 protein, and a
  // meal with no macro figures at all reports protein/fat/carb as null ("—").
  const kcalTotal = numbered.reduce((acc, it) => acc + (it.kcal ?? 0), 0);
  return {
    items,
    totals: {
      kcal: round1(kcalTotal),
      protein_g: sumNullable(numbered, (i) => i.protein_g),
      fat_g: sumNullable(numbered, (i) => i.fat_g),
      carb_g: sumNullable(numbered, (i) => i.carb_g),
      // Extra nutrients are summed only over items that actually carry them, and
      // stay null when none do (no fabricated 0). Computed over numbered items.
      fiber_g: sumNullable(numbered, (i) => i.fiber_g),
      sugar_g: sumNullable(numbered, (i) => i.sugar_g),
      sodium_mg: sumNullable(numbered, (i) => i.sodium_mg),
      saturated_fat_g: sumNullable(numbered, (i) => i.saturated_fat_g),
      // Vitamin/mineral totals: summed over numbered items that carry each micro;
      // null per key when none do, undefined when no item carried any (拡張①).
      micros: sumMicros(numbered.map((i) => i.micros)),
    },
    matchedCount: items.filter((i) => i.matched).length,
    numberedCount: numbered.length,
    totalsIncludeEstimate: numbered.some((i) => i.estimated),
  };
}

/** Re-exported so the handler can report it. */
export { NUTRITION_SOURCE, ENTRY_COUNT };

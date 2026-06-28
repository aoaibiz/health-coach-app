// Standard portions — the SHARED, DETERMINISTIC serving-size table that makes
// "same item = same number" hold across EVERY logging path.
//
// THE BUG THIS FIXES: the coach (chat MEAL_LOG) and the AI photo/text analysis
// both ground a standard food against the SAME official DB (e.g. ブラックコーヒー =
// food code 16045 = 4kcal/100g), but each path let the model FREELY guess the
// grams when the user didn't state an amount. Coach guessed 200g → 8kcal; AI
// analysis guessed 250g → 10kcal — the SAME coffee, two different numbers. The
// DB-grounding was already shared; the DIVERGENCE was the unstated portion.
//
// THE FIX: one table of "standard 1-serving grams" for common foods whose amount
// is usually left unsaid (drinks, rice, miso soup, egg, banana…). Both prompts
// cite the SAME values (so when the model DOES emit grams it picks the same one),
// AND the grounding layer applies this SAME table as the default when the grams
// are missing/zero — so the two paths converge on identical grams → identical
// kcal, deterministically, NOT by prompt luck.
//
// ANTI-FABRICATION: a standard portion is a "常識的な目安" for an UNSTATED amount,
// nothing more. A user-stated amount ALWAYS wins (this table is only the default
// for a missing/zero portion). The official-DB grounding is untouched — we only
// pin WHICH grams an unspecified serving uses. Foods not in this table fall back
// to the existing generic default (a neutral single serving).

import { normalizeName } from "./normalize";

/**
 * Generic single-serving fallback (grams) for a known/standard food logged with
 * NO stated amount and NO specific entry in STANDARD_PORTION_G below. A whole
 * serving for most single foods sits around 100 g. Kept here as the single source
 * of truth so the server grounding and the client grounding share ONE value
 * (previously each module hard-coded its own 100).
 */
export const DEFAULT_PORTION_G = 100;

/**
 * Standard grams for ONE serving of common foods whose quantity users usually
 * leave unsaid. Keys are NORMALIZED names (normalizeName) so a lookup matches
 * regardless of spacing / full-width / bracketed qualifiers. Values are everyday,
 * conservative 1人前 amounts — the SAME numbers cited verbatim in both the coach
 * (MEAL_LOG) prompt and the AI-analysis prompt, so the two paths agree.
 *
 * Scope is deliberately SMALL and uncontroversial: drinks (1杯/1本 ≈ 200g), the
 * rice/soup/egg/banana staples, and a few obvious singles. It is NOT a nutrition
 * table — it only fixes the portion for an UNSTATED amount; the DB still supplies
 * every kcal/PFC. A user-stated amount overrides it entirely.
 */
const STANDARD_PORTION_RAW: Record<string, number> = {
  // --- 飲み物 (1杯 = 200ml ≈ 200g / 1本(ペット) ≈ 500g は別途) -----------------
  コーヒー: 200,
  ブラックコーヒー: 200,
  ホットコーヒー: 200,
  アイスコーヒー: 200,
  珈琲: 200,
  カフェオレ: 200,
  カフェラテ: 200,
  カフェモカ: 200,
  コーヒー牛乳: 200,
  ミルクコーヒー: 200,
  プロテイン: 30, // 粉末1杯/1スクープの標準量
  ホエイプロテイン: 30,
  プロテインシェイク: 30,
  ハイボール: 350, // 氷込みの標準的なグラス1杯
  缶コーヒー: 185, // 標準的な缶 ≈ 185g
  微糖コーヒー: 185,
  緑茶: 200,
  煎茶: 200,
  お茶: 200,
  日本茶: 200,
  ほうじ茶: 200,
  麦茶: 200,
  紅茶: 200,
  ウーロン茶: 200,
  烏龍茶: 200,
  水: 200,
  お水: 200,
  牛乳: 200,
  豆乳: 200,
  オレンジジュース: 200,
  りんごジュース: 200,
  野菜ジュース: 200,
  スポーツドリンク: 500, // 標準ペットボトル
  みそ汁: 200,
  味噌汁: 200,
  スープ: 200,
  コーンスープ: 200,
  // --- 主食 / 定番 -------------------------------------------------------------
  ごはん: 150, // 茶碗1杯
  ご飯: 150,
  白米: 150,
  めし: 150,
  玄米ごはん: 150,
  おにぎり: 110, // 1個
  食パン: 60, // 6枚切り1枚
  トースト: 60,
  バナナ: 100, // 1本(可食部)
  卵: 50, // 1個(可食部)
  たまご: 50,
  ゆで卵: 50,
  目玉焼き: 50,
  鶏むね肉: 100, // 主菜1人前
  "鶏むね肉 皮なし": 100,
  鶏胸肉: 100,
  "鶏胸肉 皮なし": 100,
  鶏むね: 100,
  鶏胸: 100,
  むね肉: 100,
  鶏肉: 100,
  チキン: 100,
  ささみ: 80,
  鶏ささみ: 80,
  鶏もも肉: 100,
  鶏もも: 100,
  豚バラ: 80,
  豚バラ肉: 80,
  豚ばら: 80,
  豚肉: 100,
  牛肉: 100,
  鮭: 80, // 切り身1切れ
  焼き鮭: 80,
  さば: 80,
  焼きさば: 80,
  納豆: 45, // 1パック
  ヨーグルト: 100, // 1個
  さつまいも: 150, // 1本/中サイズ
  焼き芋: 150, // 1本
  焼きいも: 150,
  りんご: 200, // 1個(可食部)
  みかん: 80, // 1個(可食部)
  豆腐: 150, // 1/2丁
};

/**
 * Normalized-key lookup table (built once). Keys are normalizeName(raw) so a
 * model name with spacing/bracket noise still matches. On the rare chance two
 * raw keys normalize to the same string, the LAST one wins (insertion order),
 * which is fine — they are equivalent serving sizes by construction.
 */
const STANDARD_PORTION_G: Map<string, number> = new Map(
  Object.entries(STANDARD_PORTION_RAW).map(([k, v]) => [normalizeName(k), v]),
);

/**
 * The standard 1-serving grams for `name`, or null when the food has no specific
 * standard portion (the caller then uses DEFAULT_PORTION_G). Matching is by
 * normalized name so spacing / full-width / bracketed qualifiers don't matter.
 * This is the ONE function both the server grounding and the client grounding
 * call, so an unstated portion resolves to the SAME grams on every path.
 */
export function standardPortionGrams(name: string): number | null {
  const norm = normalizeName(name);
  if (!norm) return null;
  return STANDARD_PORTION_G.get(norm) ?? null;
}

/**
 * Resolve the per-unit grams for a logged item: a clean stated amount (> 0) is
 * kept VERBATIM (the user's number always wins); a missing/zero amount falls back
 * to this food's standard portion, else the generic DEFAULT_PORTION_G. Returns
 * the chosen grams and whether a default kicked in (callers use that to soften
 * confidence). This is the shared resolver both grounding layers call so a
 * coffee-with-no-amount lands on the SAME grams everywhere → the SAME kcal.
 */
export function resolveStandardGrams(
  name: string,
  rawGrams: number,
): { grams: number; defaulted: boolean } {
  if (Number.isFinite(rawGrams) && rawGrams > 0) {
    return { grams: rawGrams, defaulted: false };
  }
  return { grams: standardPortionGrams(name) ?? DEFAULT_PORTION_G, defaulted: true };
}

/**
 * A compact "name≈Ng" hint list for the PROMPTS, so the coach prompt and the
 * AI-analysis prompt cite the EXACT SAME standard portions (and therefore the
 * model emits the same grams for an unstated amount on both paths). Curated to
 * the most common foods a user names without an amount — short on purpose.
 */
export const STANDARD_PORTION_PROMPT_HINTS = [
  "コーヒー/お茶/水/牛乳/ジュースなどの飲み物1杯=200g",
  "缶コーヒー1本=185g",
  "ハイボール1杯=350g",
  "プロテイン粉末1杯=30g",
  "みそ汁/スープ1杯=200g",
  "ごはん茶碗1杯=150g",
  "食パン6枚切り1枚=60g",
  "卵1個=50g",
  "鶏むね肉/鶏肉の主菜1人前=100g",
  "豚バラ1人前=80g",
  "魚の切り身1切れ=80g",
  "バナナ1本=100g",
  "納豆1パック=45g",
  "ヨーグルト1個=100g",
  "さつまいも/焼き芋1本=150g",
].join("、");

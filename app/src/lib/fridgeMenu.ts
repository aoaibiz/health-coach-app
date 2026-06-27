// chat→献立 (AIプランナー Phase2 — 冷蔵庫の写真→献立提案) client core.
//
// THE INTENT GATE + the fridge bridge, both pure/testable (no DOM beyond fetch).
// When the user sends a 冷蔵庫/食材 photo AND asks for menu ideas, the chat send
// path routes the photo to the FRIDGE analysis (this module) instead of the meal
// analyser, and attaches the identified ingredients to the coach context so it can
// propose a 献立 FROM them. It logs NOTHING — recording happens only if the user
// later picks a menu (via the existing meal-log / calendar blocks).
//
// ┌─ ANTI-FABRICATION ────────────────────────────────────────────────────────┐
// │ The ingredient list is whatever the grounded vision pipeline returned for   │
// │ the photo (mode:"fridge"). We forward ONLY the identified names (+ optional  │
// │ on-hand grams). We never add an ingredient the photo didn't show; an empty   │
// │ result is forwarded honestly as `{ok:true, ingredients:[]}` so the coach     │
// │ ASKS instead of inventing.                                                   │
// └────────────────────────────────────────────────────────────────────────────┘

import { resolveApiToken } from "./analyzeMeal";
import type { AnalyzeMealApiResponse } from "./analyzeMeal";
import type { ChatFridgeAnalysis, ChatFridgeIngredient } from "./chat";

/**
 * Does this message ask for a MENU from a fridge/ingredient photo? (the intent
 * gate for routing a photo turn to fridge analysis instead of meal logging).
 *
 * Deliberately CONSERVATIVE — it must fire on the real "冷蔵庫の写真→献立" ask but
 * NOT on a normal "log this meal I ate" photo turn (which would otherwise be
 * mis-routed and never logged). It requires a menu/"what can I make" style phrase:
 *   - explicit menu words: 献立 / メニュー / レシピ / 何作れる / 何が作れる / 何ができる /
 *     何作ろう / 作れる(もの|料理) / 夕飯どうしよう 等
 *   - OR a fridge/ingredient word (冷蔵庫 / 食材 / 材料) together with a make/ideas
 *     verb (作 / 提案 / 考え), so "冷蔵庫の中で作れる物" also matches.
 * A plain "食べた" / "記録して" never matches (that stays the meal-log path). Pure.
 */
export function isFridgeMenuIntent(text: string): boolean {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return false;

  // Strong, unambiguous menu-request phrases.
  const MENU_PHRASE =
    /献立|こんだて|メニュー|レシピ|何(が|を)?(作れ|作ろ|つくれ|つくろ|できる|出来る)|何か作|作れる(もの|料理|物)|作れそう|夕飯どうし|晩ご?飯どうし|夕食どうし|ご?飯どうし|何にしよう|何食べよう/;
  if (MENU_PHRASE.test(t)) return true;

  // Fridge/ingredient word + a make/propose/think verb → also a menu ask.
  const FRIDGE_WORD = /冷蔵庫|食材|材料|れいぞうこ/;
  const MAKE_VERB = /作|つく|提案|考え|かんが/;
  if (FRIDGE_WORD.test(t) && MAKE_VERB.test(t)) return true;

  return false;
}

/**
 * Map a raw analyze-meal API response (mode:"fridge") into the coach's fridge
 * context. We read the grounded item NAMES (+ qty-scaled grams when present) —
 * the names are what the coach reasons over to build a 献立. Items with no usable
 * name are dropped; an empty response is a valid "nothing identified" answer
 * (ok:true, ingredients:[]) so the coach asks. Never invents an ingredient.
 */
export function fridgeResponseToAnalysis(res: AnalyzeMealApiResponse): ChatFridgeAnalysis {
  const ingredients: ChatFridgeIngredient[] = [];
  for (const it of res.items ?? []) {
    const name = typeof it.name === "string" ? it.name.trim() : "";
    if (!name) continue;
    const ingredient: ChatFridgeIngredient = { name };
    if (typeof it.grams === "number" && Number.isFinite(it.grams) && it.grams > 0) {
      ingredient.grams = it.grams;
    }
    ingredients.push(ingredient);
  }
  return { ok: true, ingredients };
}

/** A photo that couldn't be read as a fridge/ingredient shot → coach asks. */
export const NON_FRIDGE_ANALYSIS: ChatFridgeAnalysis = { ok: false };

export interface AnalyzeFridgeInput {
  /** Multiple base64 JPEGs of the fridge/ingredients (already downsized). */
  imageBase64List: string[];
  /** The user's message (forwarded as a hint only — never trusted as a command). */
  text?: string;
}

export interface AnalyzeFridgeOptions {
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Endpoint, overridable for tests. */
  endpoint?: string;
}

/**
 * Call the analyze-meal endpoint in FRIDGE mode and return the identified
 * ingredients as a coach fridge-context. UNLIKE analyzeMeal, an empty result is
 * NOT an error here — an empty fridge / unreadable photo resolves to ok:false
 * (handled by the caller's catch) or ok:true with an empty list, so the coach can
 * respond honestly. Throws only on a network / auth / non-OK error; the caller
 * then attaches NON_FRIDGE_ANALYSIS so the coach asks gracefully.
 */
export async function analyzeFridge(
  input: AnalyzeFridgeInput,
  options: AnalyzeFridgeOptions = {},
): Promise<ChatFridgeAnalysis> {
  if (!input.imageBase64List || input.imageBase64List.length === 0) {
    throw new Error("画像が必要です");
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
      imageBase64List: input.imageBase64List,
      text: input.text,
      mode: "fridge",
    }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("アクセスキーを設定してください");
    throw new Error(`解析に失敗しました (${res.status})`);
  }
  const data = (await res.json()) as AnalyzeMealApiResponse;
  return fridgeResponseToAnalysis(data);
}

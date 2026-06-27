// Client-side manual-item grounding (Phase 4). The ONLY client module that
// pulls in the bundled MEXT food table, so the heavy lookup JSON loads only for
// the meal page's manual "+ 品目を追加" flow — not for chat/dashboard/profile
// (which import the light analyzeMeal/mealItems modules but not this one).
//
// Manual add grounds against the SAME matcher analysis uses (functions/_lib
// ground.findFood) against the bundled MEXT DB — a DB match → 公式DB (with its
// per-100g basis), otherwise an honest 推定値 manual item with NO fabricated
// number (there is no model estimate to anchor to).

import type { MealItem, NutritionSourceKind } from "./types";
import { clampGrams, clampQty, setItemQty, toMealItem } from "./mealItems";
import { findFood } from "../../functions/_lib/ground";
import { resolveStandardGrams } from "../../functions/_lib/standard-portions";
import { NUTRITION_SOURCE } from "../../functions/_data/lookup";
import { makeId } from "./date";
import type { MealLogItemPayload } from "./mealLogProtocol";

/**
 * Ground a manually-added item (name + grams) against the bundled MEXT DB.
 * DB match → 公式DB item (carrying its per-100g basis so later edits recompute
 * EXACTLY from the table). No match → an honest 推定値 row with null numbers
 * (nothing to fabricate from); the user can delete it or rename it.
 */
export function groundManualItem(id: string, name: string, grams: number): MealItem {
  const g = clampGrams(grams);
  const food = findFood(name);
  if (food) {
    return toMealItem({
      id,
      name,
      grams: g,
      kcal: null, // filled by recompute from the DB basis
      proteinG: null,
      fatG: null,
      carbG: null,
      sourceKind: "db",
      source: NUTRITION_SOURCE,
      confidence: "high",
      foodCode: food.food_code,
      basisPer100g: {
        foodCode: food.food_code,
        kcal: food.kcal,
        proteinG: food.protein_g,
        fatG: food.fat_g,
        carbG: food.carb_g,
        // Extra nutrients from the DB row (nullable; saturated never in the table).
        fiberG: food.fiber_g,
        sugarG: food.sugar_g,
        sodiumMg: food.sodium_mg,
        saturatedFatG: null,
        // Vitamins/minerals from the DB row (拡張①; nullable per key, absent → undefined).
        micros: food.micros ?? undefined,
      },
    });
  }
  // No DB match: an honest 推定値 row with no number (anti-fabrication).
  return toMealItem({
    id,
    name,
    grams: g,
    kcal: null,
    proteinG: null,
    fatG: null,
    carbG: null,
    sourceKind: "estimate",
    source: "推定値",
    confidence: "low",
  });
}

/**
 * Anti-fabrication upper bound for a model-supplied (label/estimate) single-item
 * kcal — mirrors functions/_lib/ground.MAX_ITEM_KCAL. A hallucinated huge number
 * is rejected (the item logs as a no-number 推定 row) rather than surfaced.
 */
const MAX_ITEM_KCAL = 10000;

/**
 * Resolve the per-unit grams to log: a stated amount (> 0) is kept verbatim; a
 * missing/zero amount falls back to THIS food's SHARED standard portion
 * (functions/_lib/standard-portions), else the generic single-serving default.
 *
 * THE INVARIANT this protects: a matched/known (公式DB / labelled) food must NEVER
 * log 0 kcal just because no quantity was stated. WHY the SHARED table: the AI
 * photo/text analysis (functions/_lib/ground.groundDish) resolves an unstated
 * portion through the EXACT SAME table, so an unstated コーヒー lands on 200g on
 * BOTH paths → the SAME kcal (fixes the coach 8kcal vs AI解析 10kcal divergence).
 * ONLY the GRAMS are defaulted — the per-100g basis / label/estimate anchor is
 * never invented; a user-stated amount always wins. The chosen portion is still a
 * 目安 the user can correct in /meal. Applied uniformly on every grounding branch
 * (db, label/estimate, fallback), so the invariant holds for append + correct,
 * single + multi photo + text. Returns the grams and whether a default kicked in.
 */
function resolveGrams(name: string, rawGrams: number): { grams: number; defaulted: boolean } {
  // clampGrams first bounds an absurd/NaN value to a clean number (≤0 → 0); the
  // shared resolver then keeps a positive amount or applies the standard portion.
  return resolveStandardGrams(name, clampGrams(rawGrams));
}

/** A finite non-negative number ≤ ceil, else null (drops garbage/negatives/absurd). */
function cleanAnchor(v: number | undefined, ceil = Infinity): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= ceil ? v : null;
}

/**
 * Ground ONE auto-log payload item from the chat into a MealItem — the core
 * no-fabrication step of the chat→食事 auto-log.
 *
 *   - source "db" (default): look the food up in the bundled MEXT DB. A match →
 *     公式DB item carrying its per-100g basis, so the LOGGED kcal/PFC are computed
 *     from the official table, NOT from anything the model wrote (db anchor
 *     numbers are deliberately ignored). No match → an honest 推定値 row with no
 *     number (nothing to fabricate from).
 *   - source "label"/"estimate": the food is NOT a standard DB food (a packaged
 *     product / supplement / drink the analyzer marked from a label or estimate).
 *     Use the model's SANITISED anchor numbers (rejecting negatives/absurd kcal),
 *     scaled to the portion, and keep it labelled ラベル値 / 推定値 — never 公式DB.
 *     A db match for such a name still prefers the DB (it's more authoritative).
 *
 * qty is applied via setItemQty so the stored numbers reflect grams × qty exactly.
 */
export function groundMealLogItem(payload: MealLogItemPayload): MealItem {
  // Safety net: an item whose grams resolved to ≤ 0 / missing gets this food's
  // SHARED standard portion (functions/_lib/standard-portions — the SAME table the
  // AI analysis uses) instead of computing 0. A DB food then logs basis × grams/100
  // (a real, 公式DB number), NOT 0 — without inventing the basis — and the chosen
  // grams MATCH the AI-analysis path for the same food. Applies on EVERY branch
  // below, so the invariant holds for db, label/estimate and the fallback alike
  // (and on append + correct via buildLoggedMeal → groundMealLogItems).
  const { grams, defaulted: portionDefaulted } = resolveGrams(payload.name, payload.grams);
  const qty = clampQty(payload.qty ?? 1);
  const source: NutritionSourceKind = payload.source ?? "db";

  // The model's source TAG drives routing: a "db" tag means "this is a standard
  // food — use the official DB". We look it up; a match → 公式DB (its numbers,
  // never the model's). A label/estimate tag means the food isn't standard, so we
  // do NOT silently override it with a DB row of a similar name — we honour the
  // model's labelled estimate (see the label/estimate branch below).
  const food = findFood(payload.name);
  if (food && source === "db") {
    // The kcal/PFC are EXACT from the official DB basis, so the number is honest.
    // But when the PORTION was a silent default (the user/model never stated an
    // amount), the figure rests on a guessed serving — so we drop the per-item
    // confidence from "high" to "medium" so the meal's confidence summary reflects
    // the estimated portion. The source stays 公式DB (the per-100g basis really is
    // the DB's) — we never mislabel it, we just stop presenting a guessed portion
    // as a fully-confirmed value (anti-"適当に入れてる" honesty).
    const item = toMealItem({
      id: makeId(),
      name: payload.name,
      grams,
      kcal: null, // recomputed from the DB basis below
      proteinG: null,
      fatG: null,
      carbG: null,
      sourceKind: "db",
      source: NUTRITION_SOURCE,
      confidence: portionDefaulted ? "medium" : "high",
      foodCode: food.food_code,
      basisPer100g: {
        foodCode: food.food_code,
        kcal: food.kcal,
        proteinG: food.protein_g,
        fatG: food.fat_g,
        carbG: food.carb_g,
        // Extra nutrients from the DB row (nullable; saturated never in the table).
        fiberG: food.fiber_g,
        sugarG: food.sugar_g,
        sodiumMg: food.sodium_mg,
        saturatedFatG: null,
        // Vitamins/minerals from the DB row (拡張①; nullable per key, absent → undefined).
        micros: food.micros ?? undefined,
      },
    });
    return setItemQty(item, qty);
  }

  // label / estimate: the model supplies the numbers (sanitised). Reject an
  // absurd kcal (>MAX_ITEM_KCAL) or a missing kcal → an honest 推定 row with no
  // number. PFC stay NULLABLE: a label/estimate item may carry only kcal, so a
  // missing macro is kept null (NOT a fabricated 0) — mirrors ground.ts. The meal
  // total then sums each macro only over items that actually have it.
  if (source === "label" || source === "estimate") {
    const kcal = cleanAnchor(payload.kcal, MAX_ITEM_KCAL);
    if (kcal !== null) {
      const item = toMealItem({
        id: makeId(),
        name: payload.name,
        grams,
        kcal,
        // A MISSING macro stays null (cleanAnchor → null for missing/garbage), so an
        // unmeasured PFC shows "—" and never pollutes the meal total as a fake 0.
        proteinG: cleanAnchor(payload.protein_g),
        fatG: cleanAnchor(payload.fat_g),
        carbG: cleanAnchor(payload.carb_g),
        // Extra nutrients stay NULLABLE too: the model may not state them. cleanAnchor
        // returns null for missing/garbage, so an unknown extra stays "—".
        fiberG: cleanAnchor(payload.fiber_g),
        sugarG: cleanAnchor(payload.sugar_g),
        sodiumMg: cleanAnchor(payload.sodium_mg),
        saturatedFatG: cleanAnchor(payload.saturated_fat_g),
        // Vitamins/minerals (拡張①): the parser already sanitised these per key.
        micros: payload.micros,
        sourceKind: source,
        source: source === "label" ? "ラベル値" : "推定値",
        confidence: source === "label" ? "medium" : "low",
      });
      return setItemQty(item, qty);
    }
  }

  // A "db" food the DB cannot match (or a label/estimate with no usable number):
  // an honest 推定値 row with NO fabricated number. Never a 公式DB figure.
  const fallback = groundManualItem(makeId(), payload.name, grams);
  return setItemQty(fallback, qty);
}

/** Ground a whole auto-log payload's items (chat→食事). Never fabricates. */
export function groundMealLogItems(items: MealLogItemPayload[]): MealItem[] {
  return items.map(groundMealLogItem);
}

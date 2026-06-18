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
 * Sensible generic fallback portion (grams) for a logged item whose effective
 * grams resolved to ≤ 0 or missing. THE INVARIANT this protects: a matched/known
 * (公式DB / labelled) food must NEVER log 0 kcal just because no quantity was
 * stated. When the model omits or zeroes the grams (the user said "焼き芋" with no
 * amount), we substitute a single, reasonable serving so the DB basis × default
 * yields a real, labelled number instead of basis × 0 = 0. ONLY the GRAMS are
 * defaulted — the per-100g basis (or the label/estimate anchor) is never invented.
 * A whole serving for most single foods sits around 100 g; this is deliberately a
 * portion ESTIMATE the user can correct in /meal, never a fabricated nutrient.
 */
const DEFAULT_PORTION_G = 100;

/**
 * Resolve the per-unit grams to log: the clamped value, or DEFAULT_PORTION_G when
 * it is ≤ 0 / missing (clampGrams already maps NaN/≤0 to 0). This keeps a known
 * food from logging 0 kcal, applied uniformly on every grounding branch (db,
 * label/estimate, fallback) — and therefore on append + correct, single + multi
 * photo + text. Returns the chosen grams and whether the default kicked in.
 */
function resolveGrams(rawGrams: number): { grams: number; defaulted: boolean } {
  const clamped = clampGrams(rawGrams);
  return clamped > 0
    ? { grams: clamped, defaulted: false }
    : { grams: DEFAULT_PORTION_G, defaulted: true };
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
  // Safety net: an item whose grams resolved to ≤ 0 / missing gets a sensible
  // default portion (DEFAULT_PORTION_G) instead of computing 0. A DB food then
  // logs basis × 100/100 (a real, 公式DB number), NOT 0 — without inventing the
  // basis. Applies on EVERY branch below, so the invariant holds for db,
  // label/estimate and the fallback alike (and on append + correct via
  // buildLoggedMeal → groundMealLogItems).
  const { grams } = resolveGrams(payload.grams);
  const qty = clampQty(payload.qty ?? 1);
  const source: NutritionSourceKind = payload.source ?? "db";

  // The model's source TAG drives routing: a "db" tag means "this is a standard
  // food — use the official DB". We look it up; a match → 公式DB (its numbers,
  // never the model's). A label/estimate tag means the food isn't standard, so we
  // do NOT silently override it with a DB row of a similar name — we honour the
  // model's labelled estimate (see the label/estimate branch below).
  const food = findFood(payload.name);
  if (food && source === "db") {
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
      confidence: "high",
      foodCode: food.food_code,
      basisPer100g: {
        foodCode: food.food_code,
        kcal: food.kcal,
        proteinG: food.protein_g,
        fatG: food.fat_g,
        carbG: food.carb_g,
      },
    });
    return setItemQty(item, qty);
  }

  // label / estimate: the model supplies the numbers (sanitised). Reject an
  // absurd kcal (>MAX_ITEM_KCAL) or a missing kcal → an honest 推定 row with no
  // number. PFC are optional and default to 0 when absent (mirrors ground.ts).
  if (source === "label" || source === "estimate") {
    const kcal = cleanAnchor(payload.kcal, MAX_ITEM_KCAL);
    if (kcal !== null) {
      const item = toMealItem({
        id: makeId(),
        name: payload.name,
        grams,
        kcal,
        proteinG: cleanAnchor(payload.protein_g) ?? 0,
        fatG: cleanAnchor(payload.fat_g) ?? 0,
        carbG: cleanAnchor(payload.carb_g) ?? 0,
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

// chatMealEstimate.ts — fill DB-miss chat-logged items with an honest AI estimate.
//
// WHY: the chat→食事 grounding (foodGrounding.groundMealLogItem) is pure/sync, so a
// food the official MEXT DB can't match (e.g. カツオのタタキ, プロテイン) logs as an
// honest 推定値 row with NO number — i.e. 0 kcal in the card. The /meal editor
// later fills such rows via a background AI estimate (MealItemsEditor.autoEstimate),
// but a user who never opens the editor is left looking at 0 kcal.
//
// This module runs that SAME enrichment at chat LOG-TIME, so a meal the coach logs
// from text ("これ食べた") shows real 推定値 numbers immediately.
//
// ANTI-FABRICATION (unchanged): numbers come from the shared analyzeMeal path and
// stay labelled 推定値 (never 公式DB). No access key / offline / model declines →
// the honest no-number row is kept (that item is returned unchanged). Mirrors the
// exact condition + call the editor uses, so behaviour is identical.

import type { Meal, MealItem } from "./types";
import { estimateSingleItem, hasApiKey } from "./analyzeMeal";
import { itemsToNutrition } from "./mealItems";

/** A DB-miss "推定値" row that has no number yet (chat-logged unknown food). */
export function itemNeedsEstimate(item: MealItem): boolean {
  return item.sourceKind === "estimate" && item.kcal == null;
}

/**
 * Fill the DB-miss (no-number 推定値) items of the just-logged meal `mealId` with a
 * real labelled AI estimate, then recompute the meal's nutrition. The per-unit grams
 * are estimated and the item's qty is re-applied (mirrors the db item flow), so a
 * "プロテイン ×2" logs twice the estimate. Returns a NEW meals array; returns the
 * input UNCHANGED when there is no key, nothing to estimate, or every estimate
 * failed (the honest no-number rows stay — never fabricated).
 */
export async function estimateLoggedMeal(meals: Meal[], mealId: string): Promise<Meal[]> {
  if (!hasApiKey()) return meals;
  const idx = meals.findIndex((m) => m.id === mealId);
  if (idx < 0) return meals;
  const items = meals[idx].nutrition?.items ?? [];
  const targets = items.filter(itemNeedsEstimate);
  if (targets.length === 0) return meals;

  const filled = new Map<string, MealItem>();
  await Promise.all(
    targets.map(async (it) => {
      try {
        // Estimate for the EFFECTIVE portion (per-unit grams × qty) so a "プロテイン
        // ×2" logs the full amount. estimateSingleItem scales its result to the grams
        // we pass, so the returned item already carries the correct total — use it
        // as-is (no extra qty re-scaling, which would double-count).
        const effGrams = it.grams * (it.qty || 1);
        const est = await estimateSingleItem(it.id, it.name, effGrams);
        if (est && est.kcal != null) filled.set(it.id, est);
      } catch {
        /* keep the honest no-number row — never fabricate */
      }
    }),
  );
  if (filled.size === 0) return meals;

  const newItems = items.map((it) => filled.get(it.id) ?? it);
  const out = meals.slice();
  out[idx] = { ...meals[idx], nutrition: itemsToNutrition(newItems) };
  return out;
}

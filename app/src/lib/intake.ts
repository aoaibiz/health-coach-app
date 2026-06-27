// Sum manually-entered nutrition across a set of meals. Pure + testable.

import type { Meal, Micros } from "./types";
import { sumMicros } from "../../functions/_lib/micros";
import { isMealEaten } from "./mealStatus";

export interface IntakeTotals {
  calories: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  /**
   * Extra-nutrient day totals (「全栄養素を出す」). NULLABLE: null when NO logged
   * meal carried that nutrient (so the dashboard shows "—", not a fabricated 0),
   * else the sum over the meals that DO have it. Independent of loggedCount.
   * 食物繊維(g) / 糖質(g) / 塩分=ナトリウム(mg) / 飽和脂肪(g)。
   */
  fiberG: number | null;
  sugarG: number | null;
  sodiumMg: number | null;
  saturatedFatG: number | null;
  /**
   * Vitamin/mineral day totals (拡張①). A keyed bag, null per key when no logged
   * meal carried it; undefined when no meal carried any micro (dashboard hides the
   * vitamin/mineral panel). Same NULL-not-0 discipline as the other extras.
   */
  micros?: Micros;
  /** How many of the given meals had any nutrition entered. */
  loggedCount: number;
}

const EMPTY: IntakeTotals = {
  calories: 0,
  proteinG: 0,
  fatG: 0,
  carbG: 0,
  fiberG: null,
  sugarG: null,
  sodiumMg: null,
  saturatedFatG: null,
  micros: undefined,
  loggedCount: 0,
};

/** Sum a nullable extra nutrient across meals: null when none carried it. */
function sumMealExtra(
  meals: Meal[],
  pick: (n: NonNullable<Meal["nutrition"]>) => number | null | undefined,
): number | null {
  const present: number[] = [];
  for (const m of meals) {
    if (!m.nutrition) continue;
    const v = pick(m.nutrition);
    if (typeof v === "number" && Number.isFinite(v)) present.push(v);
  }
  if (present.length === 0) return null;
  return Math.round(present.reduce((a, b) => a + b, 0) * 10) / 10;
}

/**
 * Add up calories + PFC (+ extra nutrients) from each meal's optional nutrition.
 *
 * ANTI-FABRICATION (AIプランナー 第3陣D — 食事プラン): not-yet-eaten PLAN meals
 * (status "planned") are EXCLUDED here — the single chokepoint every nutrition
 * aggregation flows through (dashboard / calendar / coachContext / history). So a
 * proposed 献立 the user confirmed shows on the 食事画面 (with a 「食べた」 button) but
 * NEVER inflates 摂取/PFC/達成 until the user marks it eaten — exactly like the
 * workout side excludes `planned` from 総挙上量/消費kcal. ABSENT status → eaten, so
 * every pre-feature + chat-logged + manual meal is counted unchanged.
 */
export function sumIntake(allMeals: Meal[]): IntakeTotals {
  const meals = allMeals.filter(isMealEaten);
  const base = meals.reduce<IntakeTotals>((acc, meal) => {
    const n = meal.nutrition;
    if (!n) return acc;
    const has =
      n.calories != null ||
      n.proteinG != null ||
      n.fatG != null ||
      n.carbG != null;
    if (!has) return acc;
    return {
      ...acc,
      calories: acc.calories + (n.calories ?? 0),
      proteinG: acc.proteinG + (n.proteinG ?? 0),
      fatG: acc.fatG + (n.fatG ?? 0),
      carbG: acc.carbG + (n.carbG ?? 0),
      loggedCount: acc.loggedCount + 1,
    };
  }, EMPTY);
  // Extra nutrients are summed independently (nullable) so a meal missing one
  // doesn't fabricate a 0, and a day with none shows "—".
  base.fiberG = sumMealExtra(meals, (n) => n.fiberG);
  base.sugarG = sumMealExtra(meals, (n) => n.sugarG);
  base.sodiumMg = sumMealExtra(meals, (n) => n.sodiumMg);
  base.saturatedFatG = sumMealExtra(meals, (n) => n.saturatedFatG);
  // Vitamin/mineral day totals (拡張①): summed across meals that carry each micro;
  // null per key when none, undefined when no meal carried any.
  base.micros = sumMicros(meals.map((m) => m.nutrition?.micros));
  return base;
}

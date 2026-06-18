// Sum manually-entered nutrition across a set of meals. Pure + testable.

import type { Meal } from "./types";

export interface IntakeTotals {
  calories: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  /** How many of the given meals had any nutrition entered. */
  loggedCount: number;
}

const EMPTY: IntakeTotals = {
  calories: 0,
  proteinG: 0,
  fatG: 0,
  carbG: 0,
  loggedCount: 0,
};

/** Add up calories + PFC from each meal's optional manual nutrition. */
export function sumIntake(meals: Meal[]): IntakeTotals {
  return meals.reduce<IntakeTotals>((acc, meal) => {
    const n = meal.nutrition;
    if (!n) return acc;
    const has =
      n.calories != null ||
      n.proteinG != null ||
      n.fatG != null ||
      n.carbG != null;
    if (!has) return acc;
    return {
      calories: acc.calories + (n.calories ?? 0),
      proteinG: acc.proteinG + (n.proteinG ?? 0),
      fatG: acc.fatG + (n.fatG ?? 0),
      carbG: acc.carbG + (n.carbG ?? 0),
      loggedCount: acc.loggedCount + 1,
    };
  }, EMPTY);
}

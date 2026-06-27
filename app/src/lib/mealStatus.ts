// Plan vs eaten filter for meals (AIプランナー 第3陣D — 食事フロー). The exact
// twin of workout.ts isPlanned/isDone, so the same anti-fabrication contract
// holds for meals: a not-yet-eaten PLAN (status "planned") must NOT inflate
// today's 摂取/PFC/達成 until the user presses 「食べた」. Pure + framework-free so
// every aggregation (intake, dashboard, coachContext) shares ONE boundary.

import type { Meal } from "./types";

/**
 * True when a meal is a not-yet-eaten PLAN (AIプランナー 第3陣D). ABSENT status
 * means eaten (every pre-feature + chat-logged + manually-entered meal), so ONLY
 * the explicit "planned" returns true. A plan must not inflate today's 摂取, so the
 * intake/dashboard/coach aggregations count `isMealEaten` meals only.
 */
export function isMealPlanned(m: Meal): boolean {
  return m.status === "planned";
}

/** True when a meal is actually EATEN. ABSENT → eaten. The inverse of
 *  isMealPlanned; the boundary every intake/coach aggregation counts. */
export function isMealEaten(m: Meal): boolean {
  return m.status !== "planned";
}

/**
 * Keep only the EATEN meals from a list (drops not-yet-eaten plans). The single
 * place the planned-exclusion is applied for the nutrition aggregations, so a
 * planned 献立 shows on the 食事画面 (with a 「食べた」 button) but never counts toward
 * 摂取/PFC/達成 until the user marks it eaten. Pure.
 */
export function eatenMeals(meals: Meal[]): Meal[] {
  return meals.filter(isMealEaten);
}

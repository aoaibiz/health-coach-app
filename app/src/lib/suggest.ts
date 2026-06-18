// Deterministic "what's missing / what to eat next" hint for the dashboard.
//
// This is NOT an LLM call and contains no fabricated nutrition numbers — it
// only looks at which macro is furthest below target and names common,
// well-known foods rich in that macro. Phase 3 will replace/augment this with
// grounded photo analysis. Pure + testable.

import type { IntakeTotals } from "./intake";
import type { NutritionTargets } from "./types";

export interface Suggestion {
  /** Which macro is most lacking, or null if all targets are met. */
  macro: "protein" | "fat" | "carb" | "calories" | null;
  /** Grams (or kcal for calories) still remaining for that macro. */
  remaining: number;
  /** Short, friendly Japanese hint. */
  message: string;
}

/** Foods commonly associated with each macro (no per-item numbers asserted). */
const FOOD_HINTS: Record<"protein" | "fat" | "carb", string> = {
  protein: "鶏むね肉・卵・プロテイン・魚",
  fat: "ナッツ・アボカド・オリーブオイル",
  carb: "白米・オートミール・果物・さつまいも",
};

/**
 * Returns the single most actionable gap for the day. Protein is prioritised
 * when multiple macros are short, since it's hardest to hit and most asked
 * about by lifters.
 */
export function suggestNext(
  intake: IntakeTotals,
  targets: NutritionTargets,
): Suggestion {
  const proteinGap = targets.proteinG - intake.proteinG;
  const fatGap = targets.fatG - intake.fatG;
  const carbGap = targets.carbG - intake.carbG;
  const calorieGap = targets.calories - intake.calories;

  // Everything (roughly) met → positive close-out message.
  if (proteinGap <= 0 && fatGap <= 0 && carbGap <= 0 && calorieGap <= 0) {
    return {
      macro: null,
      remaining: 0,
      message: "今日の目標は達成済みです。お疲れさまでした！",
    };
  }

  // Prioritise protein, then carbs, then fat (by nutritional importance for
  // training), but only suggest a macro that's actually still short.
  if (proteinGap > 0) {
    return {
      macro: "protein",
      remaining: proteinGap,
      message: `タンパク質があと約 ${Math.round(proteinGap)}g 足りません。${FOOD_HINTS.protein} などを足しましょう。`,
    };
  }
  if (carbGap > 0) {
    return {
      macro: "carb",
      remaining: carbGap,
      message: `炭水化物があと約 ${Math.round(carbGap)}g 足りません。${FOOD_HINTS.carb} などで補給を。`,
    };
  }
  if (fatGap > 0) {
    return {
      macro: "fat",
      remaining: fatGap,
      message: `脂質があと約 ${Math.round(fatGap)}g 足りません。${FOOD_HINTS.fat} などから。`,
    };
  }
  // PFC met but calories still under (rare): nudge on calories.
  return {
    macro: "calories",
    remaining: calorieGap,
    message: `あと約 ${Math.round(calorieGap)} kcal 摂取の余地があります。`,
  };
}

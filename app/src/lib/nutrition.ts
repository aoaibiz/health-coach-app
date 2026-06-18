// Deterministic nutrition math — BMR, TDEE, and daily PFC targets.
//
// Every number here is grounded in a published, named formula so the UI can be
// transparent ("計算方法: Mifflin-St Jeor") and nothing is fabricated. These are
// pure functions: no DOM, no storage, no network — fully unit-tested.
//
// Sources:
//   Mifflin MD, St Jeor ST, et al. (1990) — the modern default BMR equation.
//   Katch-McArdle — lean-body-mass BMR (more accurate when body-fat% is known).
//   Activity multipliers — standard Harris-Benedict TDEE factors.

import type { ActivityLevel, Goal, NutritionTargets, Profile } from "./types";

/** TDEE = BMR × multiplier. Standard factors used by virtually all calculators. */
export const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** Calorie multiplier applied to TDEE for each goal. */
export const GOAL_CALORIE_FACTOR: Record<Goal, number> = {
  lose_fat: 0.8, // ~20% deficit — a sustainable cut, not an extreme crash diet.
  maintain: 1.0,
  gain_muscle: 1.15, // ~15% surplus — a lean bulk.
};

/** Protein target in grams per kg of bodyweight, by goal. */
export const PROTEIN_PER_KG: Record<Goal, number> = {
  lose_fat: 2.0, // high protein preserves muscle in a deficit
  maintain: 1.8,
  gain_muscle: 2.0,
};

/** Share of target calories that comes from fat. */
const FAT_CALORIE_SHARE = 0.25;

const KCAL_PER_G_PROTEIN = 4;
const KCAL_PER_G_FAT = 9;
const KCAL_PER_G_CARB = 4;

export interface BMRResult {
  value: number;
  /** Human-readable formula name, for transparency in the UI. */
  method: string;
}

function round(n: number): number {
  return Math.round(n);
}

/** True only for a usable body-fat percentage (strictly inside 0–60). */
function hasUsableBodyFat(pct: number | undefined): pct is number {
  return typeof pct === "number" && pct > 0 && pct < 60;
}

/**
 * Basal Metabolic Rate.
 * Uses Katch-McArdle when a usable body-fat% is present (more accurate),
 * otherwise Mifflin-St Jeor. Result is rounded to whole kcal.
 */
export function calcBMR(p: Profile): BMRResult {
  if (hasUsableBodyFat(p.bodyFatPct)) {
    const leanMass = p.weightKg * (1 - p.bodyFatPct / 100);
    return { value: round(370 + 21.6 * leanMass), method: "Katch-McArdle" };
  }
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  // Mifflin-St Jeor: +5 for male, −161 otherwise. "other" uses the female form.
  const sexOffset = p.sex === "male" ? 5 : -161;
  return { value: round(base + sexOffset), method: "Mifflin-St Jeor" };
}

/** Total Daily Energy Expenditure, rounded to whole kcal. */
export function calcTDEE(bmr: number, activity: ActivityLevel): number {
  return round(bmr * ACTIVITY_MULTIPLIERS[activity]);
}

/**
 * Full daily targets derived from a Profile.
 * Carbs are the remainder of the calorie budget after protein and fat, and are
 * floored at 0 so an aggressive deficit never yields a negative number.
 */
export function calcTargets(p: Profile): NutritionTargets {
  const bmrResult = calcBMR(p);
  const bmr = bmrResult.value;
  const tdee = calcTDEE(bmr, p.activityLevel);
  const calories = round(tdee * GOAL_CALORIE_FACTOR[p.goal]);

  const proteinG = round(PROTEIN_PER_KG[p.goal] * p.weightKg);
  const fatG = round((calories * FAT_CALORIE_SHARE) / KCAL_PER_G_FAT);

  const remainingKcal =
    calories - proteinG * KCAL_PER_G_PROTEIN - fatG * KCAL_PER_G_FAT;
  const carbG = Math.max(0, round(remainingKcal / KCAL_PER_G_CARB));

  return {
    bmr,
    tdee,
    calories,
    proteinG,
    fatG,
    carbG,
    bmrMethod: bmrResult.method,
  };
}

import type { Exercise } from "./types";
import { isWeightedExercise } from "./burn";
import { exerciseVolume, exerciseTotalReps } from "./workoutSets";

/** True when an exercise has an actual name (not a blank/placeholder row). */
function isNamed(e: Exercise): boolean {
  return e.name.trim() !== "";
}

/**
 * Volume contributed by one exercise (kg). When per-set data is present
 * (Phase 5), it's the EXACT Σ weight × reps over the sets — never the scalar
 * approximation. Otherwise it's the legacy sets × reps × weight. Bodyweight
 * exclusion is applied by the callers, not here.
 */
function exerciseVolumeOf(e: Exercise): number {
  if (e.setEntries && e.setEntries.length > 0) {
    return exerciseVolume(e.setEntries);
  }
  return e.sets * e.reps * e.weight;
}

/** Reps contributed by one exercise. Σ reps over sets when present, else sets×reps. */
function exerciseRepsOf(e: Exercise): number {
  if (e.setEntries && e.setEntries.length > 0) {
    return exerciseTotalReps(e.setEntries);
  }
  return e.sets * e.reps;
}

/**
 * Total training volume = Σ sets × reps × weight (kg) — *weighted moves only*.
 *
 * Two exclusions:
 *  - Blank-name rows: a freshly-added row carries placeholder sets/reps/weight
 *    (e.g. 3×10) the user hasn't committed to, so counting it would show a
 *    phantom total for zero entered exercises.
 *  - Bodyweight/cardio moves (背筋/腹筋/腕立て/ランニング…): their "weight" is
 *    the body, not a barbell, so weight×reps×sets is meaningless. Counting them
 *    produced the "120kg 総挙上量 for 背筋" bug. They contribute 0 here; their
 *    effort is still captured by the MET-based calorie burn (workoutBurn).
 *
 * A weighted move with weight 0 also contributes 0 (0 × reps × sets), so the
 * total only reflects real load lifted.
 */
export function totalVolume(exercises: Exercise[]): number {
  return exercises
    .filter(isNamed)
    .filter(isWeightedExercise)
    .reduce((sum, e) => sum + exerciseVolumeOf(e), 0);
}

/** Count of exercises that have at least a name. */
export function exerciseCount(exercises: Exercise[]): number {
  return exercises.filter(isNamed).length;
}

/**
 * Count of named exercises that count toward 総挙上量 (weighted moves with an
 * actual load). Used to decide whether to surface 総挙上量 at all — a
 * bodyweight-only day has none, so showing "0kg 総挙上量" would imply a lift
 * that never happened.
 */
export function weightedExerciseCount(exercises: Exercise[]): number {
  return exercises
    .filter(isNamed)
    .filter(isWeightedExercise)
    // "Real load" = positive volume. For per-set exercises that's any set with
    // weight×reps > 0; for legacy ones it reduces to the old weight > 0 check
    // (weight>0 with the seeded reps/sets → positive volume).
    .filter((e) => exerciseVolumeOf(e) > 0).length;
}

/**
 * Total reps = Σ sets × reps across named exercises. The meaningful effort
 * metric for bodyweight days (where 総挙上量 is 0), e.g. 腹筋 3×20 → 60回.
 */
export function totalReps(exercises: Exercise[]): number {
  return exercises
    .filter(isNamed)
    .reduce((sum, e) => sum + exerciseRepsOf(e), 0);
}

/** Format a number with thousands separators (e.g. 12,345). */
export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString("ja-JP");
}

/**
 * Compute a stepper's next value when a button is tapped or a field is typed.
 * Clamps to `min` and rounds to 2 decimals (so 2.5kg increments stay exact).
 * Non-finite input (e.g. an empty number field) falls back to `min`. Pure so
 * the −/+ behaviour — and that the shown value reflects the change — is tested.
 */
export function stepValue(current: number, delta: number, min = 0): number {
  const next = (Number.isFinite(current) ? current : min) + delta;
  return Math.max(min, Math.round(next * 100) / 100);
}

/** The value a stepper should DISPLAY between − and + (never NaN/undefined). */
export function displayStepValue(value: number, min = 0): number {
  return Number.isFinite(value) ? value : min;
}

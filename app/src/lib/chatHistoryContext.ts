// Recent-history context for the coach (Feature ②) — the fix for "コーチが今日(24h)
// しか見れない". Builds a compact, token-bounded digest of the LAST FEW DAYS
// (excluding today) from the same local stores the dashboard uses, so the coach
// can see trends (摂取/運動/睡眠) without the prompt ballooning. Pure + testable:
// the caller passes the already-loaded meals/workouts/sleep + the day keys, so
// there is no DOM/storage access here.
//
// HONESTY: every number is read straight from the user's own logged records and
// summarised (kcal totals, counts, sleep length). A day with nothing logged is
// simply omitted — nothing is invented for a quiet day.

import type { Meal, SleepLog, Workout } from "./types";
import type { RecentDaySummary } from "./chat";
import { sumIntake } from "./intake";
import { workoutBurn } from "./burn";
import { formatDateLabel, shiftDateKey } from "./date";
import { summarizeSleep } from "./sleepLog";

export type { RecentDaySummary };

/** How many recent days (excluding today) the coach digest spans by default. */
export const RECENT_DAYS_DEFAULT = 7;

/**
 * Build the recent-days digest for the N days BEFORE `todayKey` (most-recent
 * first). Each day with any logged meal/workout/sleep becomes one summary line;
 * empty days are skipped. `weightKg` (from the profile) is needed for the burn
 * estimate; when absent, burn is omitted (never fabricated).
 */
export function buildRecentDays(args: {
  todayKey: string;
  meals: Meal[];
  workouts: Record<string, Workout>;
  sleep: Record<string, SleepLog>;
  weightKg?: number | null;
  days?: number;
}): RecentDaySummary[] {
  const { todayKey, meals, workouts, sleep } = args;
  const span = args.days ?? RECENT_DAYS_DEFAULT;
  const weightKg = typeof args.weightKg === "number" && args.weightKg > 0 ? args.weightKg : null;

  const out: RecentDaySummary[] = [];
  for (let i = 1; i <= span; i++) {
    const dateKey = shiftDateKey(todayKey, -i);
    const dayMeals = meals.filter((m) => m.date === dateKey);
    const workout = workouts[dateKey];
    const exercises = workout?.exercises ?? [];
    const sleepLog = sleep[dateKey] ?? null;

    const intake = sumIntake(dayMeals);
    const hasIntake = intake.loggedCount > 0;
    const exerciseCount = exercises.filter((e) => e.name.trim() !== "").length;
    const burnKcal = weightKg ? workoutBurn(exercises, weightKg).totalKcal : 0;
    const sleepSummary = summarizeSleep(sleepLog);

    // Skip a day with nothing logged at all (don't pad the prompt / imply a quiet
    // day was "empty" — not-logged ≠ nothing-happened).
    if (!hasIntake && exerciseCount === 0 && !sleepSummary) continue;

    const day: RecentDaySummary = { label: formatDateLabel(dateKey) };
    if (hasIntake) {
      day.intakeKcal = Math.round(intake.calories);
      day.mealCount = dayMeals.length;
    }
    if (exerciseCount > 0) {
      day.exerciseCount = exerciseCount;
      if (weightKg) day.burnKcal = Math.round(burnKcal);
    }
    if (sleepSummary) {
      // Only the length is needed in the digest line (keep it compact).
      day.sleep = sleepLengthOnly(sleepLog);
    }
    out.push(day);
  }
  return out;
}

/** Just the sleep length string ("7時間0分") for the compact digest, or undefined. */
function sleepLengthOnly(log: SleepLog | null): string | undefined {
  if (!log) return undefined;
  const summary = summarizeSleep(log);
  if (!summary) return undefined;
  // summarizeSleep returns "23:00→07:00（7時間0分）"; pull the length when present.
  const m = /（(.+?)）/.exec(summary);
  return m ? m[1] : summary;
}

/** Convenience: today's sleep one-liner for the coach context (or undefined). */
export function todaySleepSummary(
  sleep: Record<string, SleepLog>,
  todayKey: string,
): string | undefined {
  return summarizeSleep(sleep[todayKey] ?? null) ?? undefined;
}

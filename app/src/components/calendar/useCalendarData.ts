"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadMeals, loadProfile, loadWorkouts } from "@/lib/storage";
import { loadWeightLog } from "@/lib/weightLog";
import { calcTargets } from "@/lib/nutrition";
import { sumIntake } from "@/lib/intake";
import { workoutBurn } from "@/lib/burn";
import { totalVolume, weightedExerciseCount, isDone } from "@/lib/workout";
import { isMealEaten } from "@/lib/mealStatus";
import { classifyDayNutrition, type NutrientComparison } from "@/lib/calendar";
import type {
  Exercise,
  Meal,
  NutritionTargets,
  Profile,
  Workout,
} from "@/lib/types";
import type { WeightEntry } from "@/lib/weightLog";
import { DATA_CHANGED_EVENT } from "@/lib/syncData";

/** Everything the day-detail panel needs for one date. Deterministic. */
export interface DayDetail {
  date: string;
  /** Meals logged that day, time-sorted (same order as the meal page). */
  meals: Meal[];
  /** Named exercises logged that day (blank placeholder rows filtered out). */
  exercises: Exercise[];
  /** Real intake totals + how many meals carried nutrition. */
  intake: ReturnType<typeof sumIntake>;
  /** Labeled MET burn estimate for the day (0 when no profile / no workout). */
  burnKcal: number;
  /** 総挙上量 (kg) — weighted lifts only. */
  volume: number;
  /** Whether any real weighted lift exists (decides 総挙上量 visibility). */
  hasWeighted: boolean;
  /** That day's logged body weight, or null. */
  weightKg: number | null;
  /** kcal + PFC verdicts vs targets (all "unknown" when no profile). */
  nutrition: NutrientComparison[];
  /** True when any logged meal's nutrition is (partly) an AI estimate/label. */
  intakeIncludesEstimate: boolean;
  /** True when the day has NO meal, workout, or weight at all. */
  isEmpty: boolean;
}

export interface CalendarData {
  profile: Profile | null;
  targets: NutritionTargets | null;
  /** Set of day-keys that have ANY logged data — for the grid markers. */
  markedDays: Set<string>;
  /** Build the full detail for a given date (pure over the loaded snapshot). */
  detailFor: (date: string) => DayDetail;
}

const onlyNamed = (exercises: Exercise[]): Exercise[] =>
  exercises.filter((e) => e.name.trim() !== "");

/**
 * Loads meals + workouts + weight + profile once and exposes deterministic
 * per-day aggregation. Re-reads on focus / cross-tab storage so the calendar
 * stays in lock-step with what's logged on the other pages (全ページ連動) —
 * exactly the listener pattern useDailyData uses. No separate store, no LLM,
 * no fabrication.
 */
export function useCalendarData(): { data: CalendarData; ready: boolean } {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [workouts, setWorkouts] = useState<Record<string, Workout>>({});
  const [weights, setWeights] = useState<WeightEntry[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setMeals(loadMeals());
      setWorkouts(loadWorkouts());
      setWeights(loadWeightLog());
      setProfile(loadProfile());
    };
    refresh();
    setReady(true);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    // In-tab login restore (mergeOnLogin) doesn't fire `storage`; listen for the
    // same-document signal so the calendar fills in right after login.
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
  }, []);

  const targets = useMemo<NutritionTargets | null>(
    () => (profile ? calcTargets(profile) : null),
    [profile],
  );

  // Fast lookups built once per snapshot.
  const weightByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of weights) m.set(w.date, w.weightKg);
    return m;
  }, [weights]);

  const markedDays = useMemo(() => {
    // Only ACTUAL records mark a day — a not-yet-eaten planned meal or a not-done
    // planned exercise is intent, not history (consistent with every other
    // aggregation; keeps the calendar from presenting a plan as a logged record).
    const days = new Set<string>();
    for (const meal of meals) if (isMealEaten(meal)) days.add(meal.date);
    for (const [date, w] of Object.entries(workouts)) {
      if (onlyNamed(w.exercises).filter(isDone).length > 0) days.add(date);
    }
    for (const w of weights) days.add(w.date);
    return days;
  }, [meals, workouts, weights]);

  const detailFor = useCallback(
    (date: string): DayDetail => {
      const dayMeals = meals
        .filter((m) => m.date === date && isMealEaten(m))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const exercises = onlyNamed(workouts[date]?.exercises ?? []).filter(isDone);
      const intake = sumIntake(dayMeals);
      // Burn needs a bodyweight: prefer that day's logged weight, else the
      // profile's. Without either we can't ground a burn → 0 (never invented).
      const bodyweight = weightByDate.get(date) ?? profile?.weightKg ?? null;
      const burn =
        bodyweight != null
          ? workoutBurn(exercises, bodyweight)
          : { totalKcal: 0, perExercise: [] };
      const weightKg = weightByDate.get(date) ?? null;
      const intakeIncludesEstimate = dayMeals.some(
        (m) => m.nutrition?.estimated === true,
      );
      const nutrition = classifyDayNutrition(
        {
          calories: intake.calories,
          proteinG: intake.proteinG,
          fatG: intake.fatG,
          carbG: intake.carbG,
        },
        targets
          ? {
              calories: targets.calories,
              proteinG: targets.proteinG,
              fatG: targets.fatG,
              carbG: targets.carbG,
            }
          : null,
      );

      return {
        date,
        meals: dayMeals,
        exercises,
        intake,
        burnKcal: burn.totalKcal,
        volume: totalVolume(exercises),
        hasWeighted: weightedExerciseCount(exercises) > 0,
        weightKg,
        nutrition,
        intakeIncludesEstimate,
        isEmpty:
          dayMeals.length === 0 && exercises.length === 0 && weightKg == null,
      };
    },
    [meals, workouts, weightByDate, profile, targets],
  );

  const data = useMemo<CalendarData>(
    () => ({ profile, targets, markedDays, detailFor }),
    [profile, targets, markedDays, detailFor],
  );

  return { data, ready };
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { loadMeals, loadProfile, loadWorkouts } from "@/lib/storage";
import { calcTargets } from "@/lib/nutrition";
import { sumIntake } from "@/lib/intake";
import { workoutBurn } from "@/lib/burn";
import { totalVolume, totalReps, weightedExerciseCount, exerciseCount } from "@/lib/workout";
import { isMealEaten } from "@/lib/mealStatus";
import type { Meal, NutritionTargets, Profile, Workout } from "@/lib/types";
import { DATA_CHANGED_EVENT } from "@/lib/syncData";

export interface DailyData {
  profile: Profile | null;
  targets: NutritionTargets | null;
  intake: ReturnType<typeof sumIntake>;
  burnKcal: number;
  netKcal: number;
  volume: number;
  /** Σ sets×reps across named exercises — the bodyweight-day effort metric. */
  totalReps: number;
  /** Whether the day has any real weighted lift (decides 総挙上量 visibility). */
  hasWeighted: boolean;
  exerciseCount: number;
  mealCount: number;
  /** True when any logged meal's nutrition is (partly) an AI estimate/label. */
  intakeIncludesEstimate: boolean;
}

/**
 * Aggregates everything the dashboard needs for one day from localStorage.
 * Re-reads on `date` change. Deterministic — no LLM, no fabrication.
 */
export function useDailyData(date: string): { data: DailyData; ready: boolean } {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [workouts, setWorkouts] = useState<Record<string, Workout>>({});
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setMeals(loadMeals());
      setWorkouts(loadWorkouts());
      setProfile(loadProfile());
    };
    refresh();
    setReady(true);

    // 全ページ連動: editing the profile (e.g. 目標体重) or logging meals/workouts
    // on another view/tab should reflect on the 成果 dashboard when the user
    // returns — re-read on focus / cross-tab storage. Mirrors the hasKey
    // listener pattern in useChat / MealEditor.
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    // Same-document login restore (mergeOnLogin) writes localStorage in THIS tab,
    // which does not fire `storage` — listen for the in-tab signal too so data
    // appears right after login with no manual reload.
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
  }, []);

  const data = useMemo<DailyData>(() => {
    const dayMeals = meals.filter((m) => m.date === date);
    // EATEN-only for the nutrition aggregations/flags: a not-yet-eaten PLAN
    // (status "planned", AIプランナー 第3陣D) shows on the 食事画面 but must not count
    // toward 摂取/達成 here — mirrors sumIntake's exclusion and the workout `isDone`.
    const eatenMeals = dayMeals.filter(isMealEaten);
    const workout = workouts[date];
    const exercises = workout?.exercises ?? [];

    const targets = profile ? calcTargets(profile) : null;
    const intake = sumIntake(dayMeals);
    const burn = profile ? workoutBurn(exercises, profile.weightKg) : { totalKcal: 0, perExercise: [] };
    const netKcal = intake.calories - burn.totalKcal;

    const intakeIncludesEstimate = eatenMeals.some(
      (m) => m.nutrition?.estimated === true,
    );

    return {
      profile,
      targets,
      intake,
      burnKcal: burn.totalKcal,
      netKcal,
      volume: totalVolume(exercises),
      totalReps: totalReps(exercises),
      hasWeighted: weightedExerciseCount(exercises) > 0,
      // DONE-only (mirrors burnKcal/volume): a not-yet-done PLAN must not show as
      // "1種目" next to "0 kcal" on the today snapshot.
      exerciseCount: exerciseCount(exercises),
      // Discoverability count = EATEN meals (a not-yet-eaten plan isn't a logged
      // meal yet — it shouldn't suppress the "食事タブから記録" nudge / hero hint).
      mealCount: eatenMeals.length,
      intakeIncludesEstimate,
    };
  }, [meals, workouts, profile, date]);

  return { data, ready };
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { loadMeals, loadProfile, loadWorkouts } from "@/lib/storage";
import { loadSleepLogs } from "@/lib/sleepLog";
import { loadWeightLog } from "@/lib/weightLog";
import type { WeightEntry } from "@/lib/weightLog";
import { calcTargets } from "@/lib/nutrition";
import { buildCoachHistory, type CoachHistory } from "@/lib/coachContext";
import { toDateKey } from "@/lib/date";
import type { Meal, NutritionTargets, Profile, SleepLog, Workout } from "@/lib/types";
import { DATA_CHANGED_EVENT } from "@/lib/syncData";

/**
 * Loads the user's logged stores once and exposes the SAME longitudinal summary
 * the coach reads (buildCoachHistory) — so the 履歴・傾向 screen and the AI coach
 * are grounded on identical aggregates (no second, divergent computation). Re-reads
 * on focus / cross-tab storage / login (全ページ連動), exactly like the calendar
 * data hook. Deterministic, no LLM, no fabrication.
 */
export interface HistoryData {
  profile: Profile | null;
  targets: NutritionTargets | null;
  /** The aggregated history the coach also reads (nutrition/sleep/muscle/progression/weight). */
  summary: CoachHistory;
  /** True when there is essentially nothing logged yet (drives the empty state). */
  isEmpty: boolean;
}

export function useHistoryData(): { data: HistoryData; ready: boolean } {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [workouts, setWorkouts] = useState<Record<string, Workout>>({});
  const [sleep, setSleep] = useState<Record<string, SleepLog>>({});
  const [weights, setWeights] = useState<WeightEntry[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setMeals(loadMeals());
      setWorkouts(loadWorkouts());
      setSleep(loadSleepLogs());
      setWeights(loadWeightLog());
      setProfile(loadProfile());
    };
    refresh();
    setReady(true);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
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

  const summary = useMemo<CoachHistory>(
    () =>
      buildCoachHistory({
        todayKey: toDateKey(),
        meals,
        workouts,
        sleep,
        weights,
        profile,
        targets,
      }),
    [meals, workouts, sleep, weights, profile, targets],
  );

  const isEmpty = useMemo(
    () =>
      !summary.nutrition &&
      !summary.sleep &&
      !summary.muscleGroups &&
      !summary.longTermMuscleGroups &&
      !summary.progression &&
      !summary.weightTrend,
    [summary],
  );

  const data = useMemo<HistoryData>(
    () => ({ profile, targets, summary, isEmpty }),
    [profile, targets, summary, isEmpty],
  );

  return { data, ready };
}

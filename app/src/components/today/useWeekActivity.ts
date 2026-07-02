"use client";

import { useEffect, useMemo, useState } from "react";
import { loadMeals, loadWorkouts } from "@/lib/storage";
import { loadSleepLogs } from "@/lib/sleepLog";
import { loadWeightLog, type WeightEntry } from "@/lib/weightLog";
import { isMealEaten } from "@/lib/mealStatus";
import { isDone } from "@/lib/workout";
import { shiftDateKey, fromDateKey } from "@/lib/date";
import { DATA_CHANGED_EVENT } from "@/lib/syncData";
import type { Meal, SleepLog, Workout } from "@/lib/types";

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
/** How far back the streak walk goes (guard against unbounded loops). */
const MAX_STREAK_DAYS = 365;

export interface WeekDay {
  key: string;
  /** 曜日 label (日/月/…). */
  label: string;
  active: boolean;
  isToday: boolean;
}

export interface WeekActivity {
  /** The last 7 local days, oldest first, ending today. */
  days: WeekDay[];
  /** Consecutive "recorded something" days ending today (or yesterday when
   *  today has no record yet — the streak isn't broken until the day ends). */
  streak: number;
  /** True when TODAY already has at least one record. */
  todayActive: boolean;
}

/** A day counts as "recorded" when ANY real log exists for it: an EATEN meal, a
 *  DONE named exercise, a weight entry, or a sleep record. A not-yet-eaten meal
 *  plan or a not-yet-done workout plan is a future intent, not the user's record
 *  of their day — so (mirroring every 成果/intake aggregation) it does NOT extend
 *  the streak. Deterministic; nothing fabricated. */
function buildActiveSet(
  meals: Meal[],
  workouts: Record<string, Workout>,
  sleep: Record<string, SleepLog>,
  weights: WeightEntry[],
): Set<string> {
  const active = new Set<string>();
  for (const m of meals) {
    if (isMealEaten(m) && m.date) active.add(m.date);
  }
  for (const [date, w] of Object.entries(workouts)) {
    if (w?.exercises?.some((e) => e.name.trim() !== "" && isDone(e))) active.add(date);
  }
  for (const date of Object.keys(sleep)) active.add(date);
  for (const e of weights) active.add(e.date);
  return active;
}

/** Pure: compute the 7-day strip + streak for a given today-key. */
export function computeWeekActivity(
  todayKey: string,
  activeSet: Set<string>,
): WeekActivity {
  const days: WeekDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const key = shiftDateKey(todayKey, -i);
    days.push({
      key,
      label: WEEKDAYS_JA[fromDateKey(key).getDay()],
      active: activeSet.has(key),
      isToday: i === 0,
    });
  }
  const todayActive = activeSet.has(todayKey);
  let streak = 0;
  // The streak counts back from today when today has a record, else from
  // yesterday (an unrecorded "today" is still in progress, not a break).
  let cursor = todayActive ? todayKey : shiftDateKey(todayKey, -1);
  while (streak < MAX_STREAK_DAYS && activeSet.has(cursor)) {
    streak += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return { days, streak, todayActive };
}

/**
 * Live 7-day recording strip + streak for the home screen. Reads the same
 * stores as every other view and re-reads on focus / cross-tab storage /
 * same-tab login-merge (全ページ連動) — the established pattern.
 */
export function useWeekActivity(todayKey: string): WeekActivity {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [workouts, setWorkouts] = useState<Record<string, Workout>>({});
  const [sleep, setSleep] = useState<Record<string, SleepLog>>({});
  const [weights, setWeights] = useState<WeightEntry[]>([]);

  useEffect(() => {
    const refresh = () => {
      setMeals(loadMeals());
      setWorkouts(loadWorkouts());
      setSleep(loadSleepLogs());
      setWeights(loadWeightLog());
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
  }, []);

  return useMemo(() => {
    const activeSet = buildActiveSet(meals, workouts, sleep, weights);
    return computeWeekActivity(todayKey, activeSet);
  }, [meals, workouts, sleep, weights, todayKey]);
}

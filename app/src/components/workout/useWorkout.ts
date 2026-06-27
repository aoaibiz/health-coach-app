"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadWorkouts, saveWorkouts } from "@/lib/storage";
import { DATA_CHANGED_EVENT, recordDeletion } from "@/lib/syncData";
import { shiftDateKey } from "@/lib/date";
import type { Exercise, Workout } from "@/lib/types";

const emptyWorkout = (date: string): Workout => ({
  date,
  exercises: [],
  updatedAt: new Date().toISOString(),
});

/** Manages the workout document for a given day plus the previous day (for comparison). */
export function useWorkout(date: string) {
  const [store, setStore] = useState<Record<string, Workout>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = () => setStore(loadWorkouts());
    refresh();
    setReady(true);
    // Re-read on another tab's write (`storage`), tab focus, or the cross-device
    // live-pull / login-merge writing in THIS tab (DATA_CHANGED_EVENT — the
    // same-document `storage` event does not fire). Lets a workout logged on
    // another device appear here without a reload.
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
  }, []);

  const workout = store[date] ?? emptyWorkout(date);
  const prevWorkout = store[shiftDateKey(date, -1)] ?? null;

  const persist = useCallback((next: Record<string, Workout>) => {
    setStore(next);
    saveWorkouts(next);
  }, []);

  const setExercises = useCallback(
    (updater: (prev: Exercise[]) => Exercise[]) => {
      const current = loadWorkouts();
      const day = current[date] ?? emptyWorkout(date);
      const nextExercises = updater(day.exercises);
      const next: Record<string, Workout> = {
        ...current,
        [date]: {
          date,
          exercises: nextExercises,
          updatedAt: new Date().toISOString(),
        },
      };
      persist(next);
    },
    [date, persist],
  );

  // Add / update / remove a single logged exercise — mirrors useMeals' API so
  // the page's log→collapse→edit flow reads the same as the meal page.
  const addExercise = useCallback(
    (exercise: Exercise) => setExercises((prev) => [...prev, exercise]),
    [setExercises],
  );
  const updateExercise = useCallback(
    (id: string, next: Exercise) =>
      setExercises((prev) => prev.map((e) => (e.id === id ? next : e))),
    [setExercises],
  );
  const removeExercise = useCallback(
    (id: string) => {
      // Tombstone FIRST (before setExercises → saveWorkouts → push) so the
      // merge-push's reconcile sees the tombstone and excludes the exercise
      // instead of re-adding it. Makes the delete stick across the union +
      // propagate to other devices.
      recordDeletion("workouts", id);
      setExercises((prev) => prev.filter((e) => e.id !== id));
    },
    [setExercises],
  );

  const exercises = useMemo(() => workout.exercises, [workout.exercises]);

  return {
    exercises,
    prevWorkout,
    ready,
    setExercises,
    addExercise,
    updateExercise,
    removeExercise,
  };
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadWorkouts, saveWorkouts } from "@/lib/storage";
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
    setStore(loadWorkouts());
    setReady(true);
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
    (id: string) => setExercises((prev) => prev.filter((e) => e.id !== id)),
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

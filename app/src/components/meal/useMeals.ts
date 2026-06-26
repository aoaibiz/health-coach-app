"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadMeals, saveMeals } from "@/lib/storage";
import { deletePhoto } from "@/lib/photoStore";
import type { Meal } from "@/lib/types";

/** Manages the full meal list with localStorage persistence. */
export function useMeals(date: string) {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setMeals(loadMeals());
    setReady(true);
  }, []);

  const persist = useCallback((next: Meal[]) => {
    setMeals(next);
    saveMeals(next);
  }, []);

  const addMeal = useCallback(
    (meal: Meal) => {
      persist([...loadMeals(), meal]);
    },
    [persist],
  );

  const updateMeal = useCallback(
    (id: string, patch: Partial<Meal>) => {
      persist(loadMeals().map((m) => (m.id === id ? { ...m, ...patch } : m)));
    },
    [persist],
  );

  const removeMeal = useCallback(
    async (id: string) => {
      const current = loadMeals();
      const target = current.find((m) => m.id === id);
      const photoIds = new Set([
        ...(target?.photoIds ?? []),
        ...(target?.photoId ? [target.photoId] : []),
      ]);
      for (const photoId of photoIds) {
        await deletePhoto(photoId).catch(() => undefined);
      }
      persist(current.filter((m) => m.id !== id));
    },
    [persist],
  );

  // Today's (selected day's) meals, sorted by time.
  const dayMeals = useMemo(
    () =>
      meals
        .filter((m) => m.date === date)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [meals, date],
  );

  return { dayMeals, ready, addMeal, updateMeal, removeMeal };
}

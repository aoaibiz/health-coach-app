"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadMeals, saveMeals } from "@/lib/storage";
import { deletePhoto } from "@/lib/photoStore";
import { DATA_CHANGED_EVENT, recordDeletion } from "@/lib/syncData";
import type { Meal } from "@/lib/types";

/** Manages the full meal list with localStorage persistence. */
export function useMeals(date: string) {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = () => setMeals(loadMeals());
    refresh();
    setReady(true);
    // Re-read local when another tab writes (`storage`), the tab regains focus
    // (`focus`), or the cross-device live-pull / login-merge writes in THIS tab
    // (`DATA_CHANGED_EVENT` — the `storage` event does NOT fire same-document).
    // Without this, a meal added on another device updated localStorage but the
    // open meal page kept its stale in-memory list until navigation.
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
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
        ...(target?.generatedImageId ? [target.generatedImageId] : []),
      ]);
      for (const photoId of photoIds) {
        await deletePhoto(photoId).catch(() => undefined);
      }
      // Tombstone the delete FIRST (before the save that triggers the section
      // push), so the merge-push's reconcile already sees the tombstone and
      // excludes the meal instead of re-adding it from the server. This makes the
      // delete STICK across the cross-device union. recordDeletion also pushes the
      // tombstone set + the meals section so the delete propagates to other devices.
      recordDeletion("meals", id);
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

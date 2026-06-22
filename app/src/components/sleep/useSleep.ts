"use client";

import { useCallback, useEffect, useState } from "react";
import {
  deleteSleepForDate,
  loadSleepForDate,
  loadSleepLogs,
  saveSleepForDate,
} from "@/lib/sleepLog";
import type { SleepLog } from "@/lib/types";

/**
 * Manages the sleep record for a given day. Mirrors useWorkout's shape: loads the
 * store once, exposes the selected day's record, and save/clear helpers that
 * persist + mirror into state. Re-reads on focus/storage so logging on another
 * tab/page reflects here (same pattern as useDailyData).
 */
export function useSleep(date: string) {
  const [store, setStore] = useState<Record<string, SleepLog>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = () => setStore(loadSleepLogs());
    refresh();
    setReady(true);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Read the live value for the day (state mirror; falls back to storage on a
  // first paint before the effect runs is fine — store starts {} → null).
  const sleep: SleepLog | null = store[date] ?? null;

  const save = useCallback(
    (bedtime: string, wakeTime: string) => {
      const next = saveSleepForDate(date, bedtime, wakeTime);
      setStore(next);
    },
    [date],
  );

  const clear = useCallback(() => {
    const next = deleteSleepForDate(date);
    setStore(next);
  }, [date]);

  return { sleep, ready, save, clear, reload: () => setStore(loadSleepLogs()) };
}

/** Read-only accessor for a single day (used outside the hook lifecycle if needed). */
export function readSleep(date: string): SleepLog | null {
  return loadSleepForDate(date);
}

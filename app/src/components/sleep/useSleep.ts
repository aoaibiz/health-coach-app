"use client";

import { useCallback, useEffect, useState } from "react";
import {
  deleteSleepForDate,
  loadSleepForDate,
  loadSleepLogs,
  saveSleepForDate,
} from "@/lib/sleepLog";
import type { SleepLog } from "@/lib/types";
import { DATA_CHANGED_EVENT } from "@/lib/syncData";

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
    // In-tab login restore doesn't fire `storage`; listen for the same-document
    // signal so sleep data appears right after login without a reload.
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
  }, []);

  // Read the live value for the day (state mirror; falls back to storage on a
  // first paint before the effect runs is fine — store starts {} → null).
  const sleep: SleepLog | null = store[date] ?? null;

  // Returns whether the save actually PERSISTED. A localStorage failure (quota /
  // private mode) propagates from saveSleepForDate; we catch it and return false so
  // the page shows a real error instead of a phantom "記録しました" (Codex audit C1).
  const save = useCallback(
    (bedtime: string, wakeTime: string): boolean => {
      try {
        const next = saveSleepForDate(date, bedtime, wakeTime);
        setStore(next);
        return true;
      } catch {
        return false; // not persisted — caller must not claim success.
      }
    },
    [date],
  );

  const clear = useCallback(() => {
    try {
      const next = deleteSleepForDate(date);
      setStore(next);
    } catch {
      /* a failed clear leaves the record; never surface a false "deleted" state */
    }
  }, [date]);

  return { sleep, ready, save, clear, reload: () => setStore(loadSleepLogs()) };
}

/** Read-only accessor for a single day (used outside the hook lifecycle if needed). */
export function readSleep(date: string): SleepLog | null {
  return loadSleepForDate(date);
}

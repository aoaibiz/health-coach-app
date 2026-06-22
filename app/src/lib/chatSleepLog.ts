// Chat→睡眠 auto-log glue (the sleep twin of chatWorkoutLog.ts). One pure step,
// unit-testable with no DOM/network:
//   applySleepLog — write a parsed SLEEP_LOG payload into the per-day sleep store.
//   Sleep is ONE document per day (last save wins), so there is no append/correct
//   distinction the way meals/workouts have — a new pair simply replaces the day's
//   record (the same semantics as the /sleep page saving twice).
//
// FABRICATION SAFETY: the stored record carries only the two clock times the user
// stated; the sleep LENGTH is DERIVED (sleepDurationMin, overnight-aware), never
// read from the model. An invalid pair never reaches here (the parser drops it).

import type { SleepLog } from "./types";
import { sleepDurationMin } from "./sleepLog";
import { toDateKey } from "./date";
import type { SleepLogPayload } from "./sleepLogProtocol";

/**
 * The result of applying one SLEEP_LOG payload against the per-day store.
 * `sleep` is the next store record to persist; `date` is the day it was logged to.
 */
export interface ApplySleepLogResult {
  sleep: Record<string, SleepLog>;
  date: string;
}

/**
 * Apply ONE SLEEP_LOG payload to the per-day store. Writes (upserts) the day's
 * record with the DERIVED duration cached (recomputed here so the cache is always
 * consistent with the times — single source of truth, mirroring saveSleepForDate).
 * Returns the next full store so the caller can persist + mirror it.
 */
export function applySleepLog(
  payload: SleepLogPayload,
  opts: {
    sleep: Record<string, SleepLog>;
    date?: string;
    now?: Date;
  },
): ApplySleepLogResult {
  const date = opts.date ?? toDateKey();
  const now = opts.now ?? new Date();
  const durationMin = sleepDurationMin(payload.bedtime, payload.wakeTime);
  const entry: SleepLog = {
    date,
    bedtime: payload.bedtime,
    wakeTime: payload.wakeTime,
    updatedAt: now.toISOString(),
  };
  if (durationMin !== null) entry.durationMin = durationMin;
  return { sleep: { ...opts.sleep, [date]: entry }, date };
}

// Sleep logging (睡眠メニュー) — pure core + localStorage persistence.
//
// The user records, per calendar day, their 就寝時刻 (bedtime) and 起床時刻
// (wakeTime) as local "HH:MM". The sleep LENGTH is always DERIVED here (never
// typed in) with overnight handling: bedtime 23:00 → wakeTime 07:00 = 8h. This
// mirrors the cardio feature's split — all numeric/parse logic lives in pure,
// unit-tested functions; the page/hook own React + storage wiring.
//
// HONESTY: the duration is a deterministic clock calculation, not an estimate —
// there is nothing to fabricate. An unparseable/blank time yields null (the UI
// shows "—"), never a guessed number.
//
// PERSISTENCE: a single localStorage key, one document per day (last save wins),
// exactly like workouts. It IS now wired into the cross-device server sync
// (dataApi DATA_SECTIONS → syncData SECTION_PLANS), so a sleep record follows the
// user across devices and a browser clear / device wipe can't silently lose it —
// the same durable guarantee meals/workouts/weight already have.

import type { SleepLog } from "./types";
import { clearTombstones } from "./deletionsStore";
// Best-effort server backup + cross-device delete tombstone (same runtime-only
// cycle as weightLog.ts / coachSettings.ts: these are CALLED, not evaluated at
// module load, so the syncData↔sleepLog import cycle is safe).
import { pushSectionBestEffort, recordDeletion } from "./syncData";

const SLEEP_KEY = "health-app:sleep:v1";

/** True for a well-formed 24h "HH:MM" local time string. */
export function isValidTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/** Parse "HH:MM" → minutes since midnight, or null when malformed. */
export function timeToMinutes(value: string): number | null {
  if (!isValidTime(value)) return null;
  const [h, m] = value.trim().split(":").map(Number);
  return h * 60 + m;
}

/**
 * Sleep length in minutes from bedtime → wakeTime, OVERNIGHT-AWARE:
 *   - normal night (bedtime later in the clock than wake): wake is the NEXT day,
 *     so we add 24h (23:00 → 07:00 = 8h = 480 min).
 *   - a same-day nap (bedtime BEFORE wake, e.g. 13:00 → 14:30): the plain diff.
 *   - equal times → a full 24h is implausible for a single record, so we treat
 *     bedtime == wakeTime as 0 (no logged sleep) rather than 1440.
 * Returns null when either time is unparseable (the UI shows "—", never a guess).
 */
export function sleepDurationMin(bedtime: string, wakeTime: string): number | null {
  const bed = timeToMinutes(bedtime);
  const wake = timeToMinutes(wakeTime);
  if (bed === null || wake === null) return null;
  if (wake === bed) return 0;
  const diff = wake - bed;
  return diff > 0 ? diff : diff + 24 * 60;
}

/** Format a minute count as "Nh Mm" (e.g. 480 → "8h 0m"), or "—" when null. */
export function formatDuration(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}時間${m}分`;
}

// ---- localStorage persistence ---------------------------------------------

function readStore(): Record<string, SleepLog> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SLEEP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, SleepLog>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, SleepLog>): void {
  if (typeof window === "undefined") return;
  // NO SWALLOW: a failed write (quota / private mode) MUST propagate so the UI/AI
  // never falsely reports "睡眠を記録しました" for data that did not persist
  // (phantom-success). Mirrors storage.ts writeJSON (meals/workouts), which also
  // lets localStorage.setItem throw to the caller.
  window.localStorage.setItem(SLEEP_KEY, JSON.stringify(store));
}

/** After a successful local sleep write, supersede any tombstone for the present
 *  days (so re-logging a deleted day isn't re-suppressed by the merge) and push the
 *  section to the server immediately. No-op when logged out / suppressed during a
 *  sync-internal write; never throws (push is best-effort). */
function afterSleepWrite(dates: string[]): void {
  try {
    const revived = clearTombstones("sleep", dates.filter(Boolean));
    if (revived) pushSectionBestEffort("deletions");
    pushSectionBestEffort("sleep");
  } catch {
    /* a failed push leaves local intact; the next flush/login retries it */
  }
}

/** The whole sleep store (date → SleepLog). */
export function loadSleepLogs(): Record<string, SleepLog> {
  return readStore();
}

/** Persist the whole sleep store (date → SleepLog). Used by the chat→睡眠 auto-log
 *  to write a record applySleepLog produced (it builds the next store purely). */
export function saveSleepLogs(store: Record<string, SleepLog>): void {
  writeStore(store);
  afterSleepWrite(Object.keys(store));
}

/** The sleep record for one day, or null when none. */
export function loadSleepForDate(date: string): SleepLog | null {
  return readStore()[date] ?? null;
}

/**
 * Save (upsert) the sleep record for a day. The derived durationMin is recomputed
 * here so the stored cache is always consistent with the times (single source of
 * truth). Returns the next full store so a caller/hook can mirror it into state.
 */
export function saveSleepForDate(
  date: string,
  bedtime: string,
  wakeTime: string,
  now: Date = new Date(),
): Record<string, SleepLog> {
  const store = readStore();
  const durationMin = sleepDurationMin(bedtime, wakeTime);
  const entry: SleepLog = {
    date,
    bedtime,
    wakeTime,
    updatedAt: now.toISOString(),
  };
  if (durationMin !== null) entry.durationMin = durationMin;
  const next = { ...store, [date]: entry };
  writeStore(next);
  afterSleepWrite(Object.keys(next));
  return next;
}

/** Remove a day's sleep record (used by a clear/delete action). */
export function deleteSleepForDate(date: string): Record<string, SleepLog> {
  const store = readStore();
  if (!(date in store)) return store;
  const next = { ...store };
  delete next[date];
  writeStore(next);
  // Cross-device DELETE → tombstone (id === date), so the day stays deleted on
  // other devices (the union merge would otherwise re-add it from their copy).
  recordDeletion("sleep", date);
  return next;
}

/**
 * A short, factual one-line summary of a day's sleep for the coach context, or
 * null when there's no usable record. e.g. "23:00→07:00（7時間0分）". Pure — no
 * fabrication; an unparseable record yields just the raw times without a length.
 */
export function summarizeSleep(log: SleepLog | null | undefined): string | null {
  if (!log) return null;
  const bed = isValidTime(log.bedtime) ? log.bedtime.trim() : "";
  const wake = isValidTime(log.wakeTime) ? log.wakeTime.trim() : "";
  if (!bed && !wake) return null;
  const dur = sleepDurationMin(log.bedtime, log.wakeTime);
  const range = `${bed || "?"}→${wake || "?"}`;
  return dur !== null ? `${range}（${formatDuration(dur)}）` : range;
}

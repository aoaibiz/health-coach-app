// Persistence for the GLOBALLY-shared selected date. One date drives every page
// (成果 / 食事 / 筋トレ / カレンダー) so changing it anywhere is reflected
// everywhere, survives page navigation, and survives a reload.
//
// The live value lives in React context (see SelectedDateProvider); this module
// is the pure storage seam (localStorage), kept window-guarded so it is safe in
// the static-export / SSR build and unit-testable under the node test env.

import { toDateKey } from "./date";

export const SELECTED_DATE_KEY = "health-app:selectedDate";

/** True for a well-formed YYYY-MM-DD key that names a real calendar day. */
export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  // Reject overflow like 2026-02-31 (which Date would roll into March).
  return (
    dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
  );
}

/**
 * The persisted selected date, or today when nothing is stored or the stored
 * value is malformed. Returns today on the server (no window) so render output
 * is deterministic for the static export — the real stored value is adopted in
 * an effect on the client.
 */
export function loadSelectedDate(): string {
  if (typeof window === "undefined") return toDateKey();
  try {
    const raw = window.localStorage.getItem(SELECTED_DATE_KEY);
    return isValidDateKey(raw) ? raw : toDateKey();
  } catch {
    return toDateKey();
  }
}

/** Persist the selected date. No-op on the server. */
export function saveSelectedDate(date: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SELECTED_DATE_KEY, date);
  } catch {
    // ignore (private mode / quota)
  }
}

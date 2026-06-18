// Local-date helpers. We key everything by the user's local calendar day so
// "today" matches what the owner sees on their phone.

/** Returns YYYY-MM-DD in the local timezone for the given date (default now). */
export function toDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD key into a local Date at midnight. */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Shift a date key by a number of days (can be negative). */
export function shiftDateKey(key: string, days: number): string {
  const d = fromDateKey(key);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

/** True when the given date key is today's local date. */
export function isToday(key: string): boolean {
  return key === toDateKey();
}

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** Friendly Japanese label, e.g. "6月17日 (火)". */
export function formatDateLabel(key: string): string {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 (${WEEKDAYS_JA[d.getDay()]})`;
}

/**
 * HH:MM from an ISO timestamp, in local time. Returns null for a missing or
 * unparseable timestamp (corrupt/old localStorage is a real source) so callers
 * can OMIT the entry instead of rendering "NaN:NaN" — never a fabricated time.
 */
export function formatTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * The current local date+time as "YYYY-MM-DD(曜) HH:MM" (e.g. "2026-06-18(火) 08:10"),
 * for the chat coach's time awareness. Uses the DEVICE-LOCAL clock (getFullYear/
 * getHours etc.) — for our JST users that IS Japan time — never UTC, so a coach
 * that says "もう夜" matches what the user sees on their phone. Defaults to now;
 * the Date argument is a test seam. Pure.
 */
export function formatNowText(d: Date = new Date()): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const wd = WEEKDAYS_JA[d.getDay()];
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${day}(${wd}) ${h}:${mi}`;
}

/** A short unique id without external deps. */
export function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

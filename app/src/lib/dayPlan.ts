// 1日まるごと自動プラン (AIプランナー仕上げ) — the INTENT GATE + the day-window helper.
//
// When the user explicitly asks the coach to plan their WHOLE day ("今日1日プラン
// して"／"今日の予定組んで" 等), the chat client READS the day's existing calendar
// events (so the coach can find free time), and the coach proposes a connected
// 食事＋運動＋タスク plan the user can confirm onto their Google Calendar.
//
// This module is PURE (no DOM beyond the optional Intl/Date used by the window
// helper, which is dependency-injected in tests). It only DECIDES intent + COMPUTES
// the local-day window; it never fabricates a plan or an event.
//
// ┌─ WHY A CONSERVATIVE GATE ─────────────────────────────────────────────────┐
// │ The day-plan read is gated so a normal chat turn (a single "記録して", a    │
// │ workout note, small talk) is NOT mis-routed into a calendar read + a        │
// │ full-day plan. It fires ONLY on an explicit "plan my (whole) day" ask. The  │
// │ existing meal/workout/sleep/fridge/calendar paths are untouched.            │
// └────────────────────────────────────────────────────────────────────────────┘

/**
 * Does this message explicitly ask the coach to plan the user's WHOLE day? (the
 * gate that routes a turn into the day-planner: read today's events → propose a
 * connected meal+workout+task plan).
 *
 * Deliberately CONSERVATIVE. It fires on an explicit "plan my day / organise
 * today's schedule" ask, e.g.:
 *   - 「今日1日プランして」「今日まるごとプランして」「1日のプラン立てて」
 *   - 「今日の予定を組んで」「今日のスケジュール作って」「今日の流れを考えて」
 *   - 「1日のスケジュールを立てて」「today's plan」/「plan my day」
 * It does NOT fire on:
 *   - a plain log turn (「これ食べた」「記録して」「ベンチ60kg」),
 *   - a single meal/workout request (「昼ごはん何がいい？」),
 *   - small talk (「ありがとう」),
 * so the existing single-purpose paths keep working unchanged. Pure + testable.
 */
export function isDayPlanIntent(text: string): boolean {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return false;

  // A "whole day / today" scope word. We require the request to be about the DAY,
  // not a single item, so "プラン" alone (e.g. "このプランどう?") doesn't fire.
  const DAY_SCOPE = /今日|きょう|本日|1日|一日|いちにち|today/i;

  // A "plan / organise the schedule" verb-phrase. Covers プラン/スケジュール/予定/
  // 流れ/段取り + 組む/立てる/作る/考える, and the English "plan my day".
  const PLAN_PHRASE =
    /(プラン|ぷらん|スケジュール|すけじゅーる|予定|よてい|流れ|段取り|だんどり|タイムテーブル)(を|の|で)?\s*(して|立て|たて|組ん?で?|くんで|組む|作っ?て?|つくっ?て?|考え|かんが|プランニング|決め|きめ)/;
  // English "plan my/the day" / "plan today".
  const PLAN_EN = /plan\s+(my|the|today'?s)?\s*(day|today|schedule)/i;
  // Very explicit JP combos that name the whole-day plan directly.
  const PLAN_WHOLE_DAY = /(1日|一日|いちにち|今日|きょう|本日)(まるごと|丸ごと|全部|ぜんぶ|まるっと)?\s*(プラン|ぷらん|スケジュール|予定|計画|けいかく)/;

  if (PLAN_EN.test(t)) return true;
  if (PLAN_WHOLE_DAY.test(t)) return true;
  // The general case: the message must scope to the day AND ask to build a schedule.
  if (DAY_SCOPE.test(t) && PLAN_PHRASE.test(t)) return true;

  return false;
}

/** One bound of the local-day read window (RFC3339 with the device's UTC offset). */
export interface DayWindow {
  /** Inclusive start instant of the local day (RFC3339, e.g. "...T00:00:00+09:00"). */
  timeMin: string;
  /** Exclusive end instant = local day start + 24h (RFC3339). */
  timeMax: string;
}

/**
 * Compute the [timeMin, timeMax) RFC3339 window for the user's LOCAL day that
 * `now` falls in, carrying the device's UTC offset so the instant is unambiguous
 * (the Worker reads this verbatim and never guesses a zone). `now` is injected so
 * the function is deterministic in tests; the caller passes `new Date()`.
 *
 * We build it from the local Y-M-D at 00:00 plus the device's current offset, then
 * add 24h for the end. (DST transitions can make a local day 23/25h, but a 24h
 * window from local-midnight still safely covers "today's events"; events.list is
 * an instant-range read, and the coach reasons over the listed events regardless.)
 */
export function localDayWindow(now: Date = new Date()): DayWindow {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  // Local midnight as an instant.
  const startLocal = new Date(y, m, d, 0, 0, 0, 0);
  const endLocal = new Date(startLocal.getTime() + 24 * 60 * 60 * 1000);
  return { timeMin: toLocalRfc3339(startLocal), timeMax: toLocalRfc3339(endLocal) };
}

/** Format a Date as an RFC3339 string in the DEVICE's local zone, with the explicit
 *  numeric offset (e.g. "2026-06-26T00:00:00+09:00"). No external tz tables. */
function toLocalRfc3339(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  // getTimezoneOffset() is minutes BEHIND UTC (e.g. JST = -540), so the sign flips.
  const offMin = -date.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const offH = pad(Math.floor(abs / 60));
  const offM = pad(abs % 60);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${offH}:${offM}`;
}

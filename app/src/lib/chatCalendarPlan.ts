// chat→Googleカレンダー glue (mirrors chatMealLog / chatWorkoutLog).
//
// Given a parsed CALENDAR_PLAN payload (from calendarPlanProtocol.parseCalendarReply),
// forward it to the Worker's POST /api/calendar/plan, which creates the events on
// the user's OWN Google Calendar. This module shapes the request (attaches the
// device time zone) and turns the API result into an HONEST note appended to the
// coach's reply — never claiming a calendar write that didn't happen:
//   * not connected   → ask the user to connect their calendar (no fabrication).
//   * created N events → confirm exactly how many landed.
//   * partial / failed → say so honestly.
//
// PURE of React; the provider calls it inside the send() flow.

import {
  calendarPlan,
  type CalendarPlanItemBody,
  type CalendarPlanResult,
} from "./authApi";
import { getSyncCsrfToken } from "./syncData";
import type { CalendarPlanPayload } from "./calendarPlanProtocol";

/** The device's IANA time zone (e.g. "Asia/Tokyo"), or undefined if unavailable. */
function deviceTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz ? tz : undefined;
  } catch {
    return undefined;
  }
}

export interface CalendarPlanOutcome {
  /** An honest one-paragraph note to append to the coach's reply (or null = none). */
  note: string | null;
  /** True when the API said the calendar isn't connected (UI shows connect CTA). */
  notConnected: boolean;
  /** How many events were actually created. */
  createdCount: number;
}

/**
 * Send a parsed plan to the calendar API and return an honest outcome. Uses the
 * payload's own timeZone if the coach supplied one, else the device zone. A null
 * note means "say nothing extra" (e.g. nothing to do). Network/other errors are
 * caught and reported honestly (never a fake success). `fetchImpl` is injectable
 * for tests.
 */
export async function runCalendarPlan(
  payload: CalendarPlanPayload,
  opts?: { fetchImpl?: typeof fetch },
): Promise<CalendarPlanOutcome> {
  const items: CalendarPlanItemBody[] = payload.items.map((i) => ({
    type: i.type,
    title: i.title,
    start: i.start,
    end: i.end,
    ...(i.notes ? { notes: i.notes } : {}),
  }));
  const timeZone = payload.timeZone ?? deviceTimeZone();

  let result: CalendarPlanResult;
  try {
    result = await calendarPlan(
      { items, ...(timeZone ? { timeZone } : {}) },
      getSyncCsrfToken(),
      opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined,
    );
  } catch {
    return {
      note: "（カレンダーへの登録時にエラーが発生しました。少し時間をおいてもう一度お試しください。）",
      notConnected: false,
      createdCount: 0,
    };
  }

  if (result.notConnected) {
    return {
      note: "（Googleカレンダーがまだ連携されていないため、予定は登録できませんでした。マイページの「カレンダー連携」から連携すると、次回から登録できます。）",
      notConnected: true,
      createdCount: 0,
    };
  }

  const createdCount = result.created.length;
  const failedCount = result.failed.length;
  if (createdCount === 0 && failedCount === 0) {
    return { note: null, notConnected: false, createdCount: 0 };
  }
  if (result.partial) {
    return {
      note: `（カレンダーに${createdCount}件登録しましたが、途中で連携が切れました。残りはマイページから再連携のうえお試しください。）`,
      notConnected: false,
      createdCount,
    };
  }
  if (failedCount > 0 && createdCount === 0) {
    return {
      note: "（カレンダーへの登録に失敗しました。少し時間をおいてもう一度お試しください。）",
      notConnected: false,
      createdCount: 0,
    };
  }
  const failTail = failedCount > 0 ? `（${failedCount}件は登録できませんでした）` : "";
  return {
    note: `（Googleカレンダーに${createdCount}件の予定を登録しました。${failTail}）`,
    notConnected: false,
    createdCount,
  };
}

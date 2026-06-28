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
  AuthApiError,
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

const NOT_CONNECTED_NOTE =
  "（Googleカレンダーが未連携、または再連携が必要な状態のため、予定は登録できませんでした。マイページの「カレンダー連携」から連携し直すと、次回から登録できます。）";

const WRITE_FORBIDDEN_NOTE =
  "（Googleカレンダーへの書き込みが拒否されました。マイページの「カレンダー連携」から再連携し、Google側の権限を許可してください。職場アカウントの場合は管理者ポリシーで拒否されている可能性があります。）";

function failedReasonNote(failed: CalendarPlanResult["failed"]): string {
  const reasons = new Set(failed.map((f) => f.reason));
  if (reasons.has("forbidden")) return WRITE_FORBIDDEN_NOTE;
  if (reasons.has("calendar_not_connected")) {
    return "（途中でカレンダー連携が切れました。マイページの「カレンダー連携」から再連携してください。）";
  }
  return "（Googleカレンダー側で予定を作成できませんでした。時刻やタイトルを確認して、もう一度お試しください。）";
}

function errorNote(error: unknown): CalendarPlanOutcome {
  if (error instanceof AuthApiError) {
    if (error.status === 401 || (error.status === 403 && /セッション|CSRF/i.test(error.message))) {
      return {
        note: "（ログイン状態の確認に失敗したため、カレンダーへ登録できませんでした。ページを再読み込みし、必要ならログインし直してください。）",
        notConnected: false,
        createdCount: 0,
      };
    }
    if (error.status === 403) {
      return { note: WRITE_FORBIDDEN_NOTE, notConnected: false, createdCount: 0 };
    }
    if (error.status === 429) {
      return {
        note: "（短時間にカレンダー登録が重なったため停止しました。少し時間をおいてもう一度お試しください。）",
        notConnected: false,
        createdCount: 0,
      };
    }
    if (error.status === 400) {
      return {
        note: "（カレンダー登録内容の時刻かタイトルが不正でした。開始・終了時刻を指定してもう一度お試しください。）",
        notConnected: false,
        createdCount: 0,
      };
    }
    if (error.status === 502 || error.status >= 500) {
      return {
        note: "（Googleカレンダー側の応答エラーで登録できませんでした。少し時間をおいてもう一度お試しください。）",
        notConnected: false,
        createdCount: 0,
      };
    }
  }
  return {
    note: "（カレンダーへの登録時にエラーが発生しました。少し時間をおいてもう一度お試しください。）",
    notConnected: false,
    createdCount: 0,
  };
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
  } catch (error) {
    return errorNote(error);
  }

  if (result.notConnected) {
    return {
      note: NOT_CONNECTED_NOTE,
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
      note: failedReasonNote(result.failed),
      notConnected: false,
      createdCount: 0,
    };
  }
  const failTail = failedCount > 0 ? ` ${failedCount}件は登録できませんでした。` : "";
  return {
    note: `（Googleカレンダーに${createdCount}件の予定を登録しました。${failTail}）`,
    notConnected: false,
    createdCount,
  };
}

import { describe, expect, it } from "vitest";
import { runCalendarPlan } from "./chatCalendarPlan";
import type { CalendarPlanPayload } from "./calendarPlanProtocol";

const PAYLOAD: CalendarPlanPayload = {
  timeZone: "Asia/Tokyo",
  items: [
    {
      type: "トレーニング",
      title: "筋トレ",
      start: "2026-06-28T18:00:00+09:00",
      end: "2026-06-28T18:45:00+09:00",
      notes: "懸垂、スクワット",
    },
  ],
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("runCalendarPlan", () => {
  it("tells the user to reconnect when the API says calendar is not usable", async () => {
    const outcome = await runCalendarPlan(PAYLOAD, {
      fetchImpl: fakeFetch(409, { error: "calendar_not_connected" }),
    });
    expect(outcome.notConnected).toBe(true);
    expect(outcome.createdCount).toBe(0);
    expect(outcome.note).toContain("再連携が必要");
  });

  it("surfaces a Google write-permission failure instead of a generic retry later note", async () => {
    const outcome = await runCalendarPlan(PAYLOAD, {
      fetchImpl: fakeFetch(403, {
        error: "calendar_write_forbidden",
        message: "Googleカレンダーへの書き込みが拒否されました。",
      }),
    });
    expect(outcome.notConnected).toBe(false);
    expect(outcome.createdCount).toBe(0);
    expect(outcome.note).toContain("書き込みが拒否");
    expect(outcome.note).toContain("再連携");
    expect(outcome.note).not.toContain("少し時間をおいて");
  });

  it("classifies an expired session as a login/reload problem, not a transient calendar retry", async () => {
    const outcome = await runCalendarPlan(PAYLOAD, {
      fetchImpl: fakeFetch(401, { message: "ログインが必要です" }),
    });
    expect(outcome.createdCount).toBe(0);
    expect(outcome.note).toContain("ログイン状態");
    expect(outcome.note).not.toContain("少し時間をおいて");
  });

  it("surfaces all-failed item reasons when the Worker returns a failed list", async () => {
    const outcome = await runCalendarPlan(PAYLOAD, {
      fetchImpl: fakeFetch(200, {
        created: [],
        failed: [{ title: "筋トレ", reason: "forbidden" }],
      }),
    });
    expect(outcome.createdCount).toBe(0);
    expect(outcome.note).toContain("書き込みが拒否");
  });
});

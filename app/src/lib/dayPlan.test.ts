import { describe, it, expect } from "vitest";
import { isDayPlanIntent, localDayWindow } from "./dayPlan";

// 1日まるごと自動プラン (AIプランナー仕上げ). The intent gate must fire on an explicit
// "plan my whole day" ask and STAY QUIET on a normal log / single-purpose / chat
// turn (so the existing meal/workout/sleep/fridge/calendar paths aren't mis-routed).
// The window helper must produce a zoned RFC3339 [timeMin, timeMax) for the local day.

describe("isDayPlanIntent — fires ONLY on an explicit whole-day plan ask", () => {
  it("fires on explicit day-plan phrases", () => {
    for (const t of [
      "今日1日プランして",
      "今日まるごとプランして",
      "今日の予定を組んで",
      "今日のスケジュール作って",
      "1日のスケジュールを立てて",
      "今日の1日の流れを考えて",
      "今日の予定組んで",
      "1日のプラン立てて",
      "今日のタイムテーブル作って",
      "plan my day",
      "plan today's schedule",
    ]) {
      expect(isDayPlanIntent(t)).toBe(true);
    }
  });

  it("fires when extra words surround the ask (e.g. with a mood hint)", () => {
    expect(isDayPlanIntent("今日1日プランして。夕方疲れそうだから運動は軽めで")).toBe(true);
    expect(isDayPlanIntent("冷蔵庫の写真送るね、今日の1日のスケジュール組んで")).toBe(true);
  });

  it("does NOT fire on a normal log / single-purpose / chat turn", () => {
    for (const t of [
      "これ食べた",
      "今日の昼ごはん記録して",
      "ベンチ60kg10回3セット",
      "親子丼を食べました",
      "昼ごはん何がいい？",
      "今日は何時に運動したらいい？",
      "ありがとう",
      "おはよう",
      "このプランどう思う？", // mentions プラン but isn't a day-plan ask
      "明日の予定", // not "today"
      "",
    ]) {
      expect(isDayPlanIntent(t)).toBe(false);
    }
  });

  it("requires BOTH a day scope and a plan verb (no false positive on either alone)", () => {
    expect(isDayPlanIntent("今日はいい天気だね")).toBe(false); // day word, no plan verb
    expect(isDayPlanIntent("スケジュール表ってどこ？")).toBe(false); // plan word, no day scope + no verb
  });
});

describe("localDayWindow — zoned RFC3339 [timeMin, timeMax) for the local day", () => {
  const ZONED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

  it("produces a 24h window starting at local midnight, both with an explicit offset", () => {
    const now = new Date("2026-06-26T13:45:00+09:00");
    const w = localDayWindow(now);
    expect(w.timeMin).toMatch(ZONED_RE);
    expect(w.timeMax).toMatch(ZONED_RE);
    // The clock part of timeMin is local midnight, timeMax is +24h (next midnight).
    expect(w.timeMin).toContain("T00:00:00");
    expect(w.timeMax).toContain("T00:00:00");
    // 24h apart as instants.
    expect(Date.parse(w.timeMax) - Date.parse(w.timeMin)).toBe(24 * 60 * 60 * 1000);
    // timeMin <= now < timeMax (now falls inside today's window).
    expect(Date.parse(w.timeMin)).toBeLessThanOrEqual(now.getTime());
    expect(Date.parse(w.timeMax)).toBeGreaterThan(now.getTime());
  });

  it("the offset matches the environment's offset (never a fabricated zone)", () => {
    const now = new Date();
    const w = localDayWindow(now);
    const offMin = -now.getTimezoneOffset();
    const sign = offMin >= 0 ? "+" : "-";
    const abs = Math.abs(offMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    expect(w.timeMin.endsWith(`${sign}${hh}:${mm}`)).toBe(true);
  });
});

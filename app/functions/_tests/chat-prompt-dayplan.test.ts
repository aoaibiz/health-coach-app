import { describe, it, expect } from "vitest";
import {
  buildChatPrompt,
  formatTodayEvents,
  DAY_PLAN_PROTOCOL,
  CALENDAR_PLAN_PROTOCOL,
  SYSTEM_GUARDRAILS,
  COACH_EXPERTISE,
  AUTO_LOG_PROTOCOL,
  FRIDGE_MENU_PROTOCOL,
  CALENDAR_PLAN_OPEN,
  type ChatContext,
  type ChatTurn,
} from "../_llm/chat-prompt";

// 1日まるごと自動プラン (AIプランナー仕上げ). These prove the day-planner is an ADDITIVE,
// anti-fabrication layer: it renders only REAL existing events (or an honest
// not-connected note), instructs the coach to plan AROUND them, routes a CONFIRMED
// plan through the EXISTING CALENDAR_PLAN block (no new write channel), and never
// weakens the safety floor or the existing protocols.

const TURNS: ChatTurn[] = [{ role: "user", content: "今日1日プランして" }];

describe("formatTodayEvents — renders only real existing events / honest not-connected", () => {
  it("lists timed + all-day events with a 'these are your real events' framing", () => {
    const block = formatTodayEvents({
      connected: true,
      events: [
        { summary: "会議", start: "2026-06-26T10:00:00+09:00", end: "2026-06-26T11:00:00+09:00", allDay: false },
        { summary: "出張", start: "2026-06-26", end: "2026-06-27", allDay: true },
      ],
    });
    expect(block).toContain("今日の既存の予定");
    expect(block).toContain("あなたが作った物ではありません");
    expect(block).toContain("10:00〜11:00　会議");
    expect(block).toContain("終日　出張");
    // Instructs the coach to plan AROUND them (don't move/delete/invent).
    expect(block).toContain("動かしたり消したりせず");
  });

  it("connected but empty → states the day is free (plan freely, no fabrication)", () => {
    const block = formatTodayEvents({ connected: true, events: [] });
    expect(block).toContain("予定は入っていません");
    expect(block).toContain("架空の予定は作らない");
  });

  it("not connected → an honest 'ask to connect, don't invent events' instruction", () => {
    const block = formatTodayEvents({ connected: false });
    expect(block).toContain("連携していない");
    expect(block).toContain("架空の予定を作らず");
  });

  it("returns null when there is no todayPlan context (prompt omits the section)", () => {
    expect(formatTodayEvents(undefined)).toBeNull();
  });

  it("an untitled event still blocks its time (no invented title)", () => {
    const block = formatTodayEvents({
      connected: true,
      events: [{ summary: "", start: "2026-06-26T09:00:00+09:00", end: "2026-06-26T09:30:00+09:00", allDay: false }],
    });
    expect(block).toContain("09:00〜09:30　（タイトルなし）");
  });
});

describe("DAY_PLAN_PROTOCOL — content + anti-fabrication + reuses the existing write path", () => {
  it("instructs: read existing events first, plan around them, don't invent/move them", () => {
    expect(DAY_PLAN_PROTOCOL).toContain("今日の既存の予定");
    expect(DAY_PLAN_PROTOCOL).toContain("動かしたり消したり");
    expect(DAY_PLAN_PROTOCOL).toContain("空き時間");
  });

  it("routes a CONFIRMED plan through the EXISTING CALENDAR_PLAN block (no new channel)", () => {
    expect(DAY_PLAN_PROTOCOL).toContain("CALENDAR_PLAN");
    expect(DAY_PLAN_PROTOCOL).toContain("新しい登録の仕組みは作らない");
    // Proposal turn writes nothing — only a confirmed turn emits the block.
    expect(DAY_PLAN_PROTOCOL).toContain("提案だけのターンでは絶対にブロックを出さない");
  });

  it("keeps the meal grounding + no-fabrication floor (kcal not asserted, time not invented)", () => {
    expect(DAY_PLAN_PROTOCOL).toContain("捏造しない");
    expect(DAY_PLAN_PROTOCOL).toContain("確定値として本文に断言しない");
    expect(DAY_PLAN_PROTOCOL).toContain("時刻を勝手に捏造しない");
  });
});

describe("buildChatPrompt — day-planner layer is additive, never weakens existing prompt", () => {
  it("always includes the day-plan protocol (so a 'plan my day' ask works any turn)", () => {
    const prompt = buildChatPrompt(TURNS);
    expect(prompt).toContain(DAY_PLAN_PROTOCOL);
    expect(prompt).toContain("【1日まるごと自動プラン（全連動）について】");
  });

  it("renders the existing-events block ONLY when todayPlan is attached", () => {
    const withPlan: ChatContext = {
      todayPlan: {
        connected: true,
        events: [{ summary: "歯医者", start: "2026-06-26T15:00:00+09:00", end: "2026-06-26T16:00:00+09:00", allDay: false }],
      },
    };
    const prompt = buildChatPrompt(TURNS, withPlan);
    expect(prompt).toContain("【今日の既存の予定（1日まるごと自動プラン用）】");
    expect(prompt).toContain("歯医者");

    // No todayPlan → the per-turn block is absent (but the protocol stays).
    const plain = buildChatPrompt(TURNS);
    expect(plain).not.toContain("【今日の既存の予定（1日まるごと自動プラン用）】");
    expect(plain).toContain(DAY_PLAN_PROTOCOL);
  });

  it("the safety floor + existing protocols remain intact alongside the day-plan layer", () => {
    const prompt = buildChatPrompt(TURNS, { todayPlan: { connected: true, events: [] } });
    expect(prompt).toContain(SYSTEM_GUARDRAILS);
    expect(prompt).toContain(COACH_EXPERTISE);
    expect(prompt).toContain(AUTO_LOG_PROTOCOL);
    expect(prompt).toContain(CALENDAR_PLAN_PROTOCOL);
    expect(prompt).toContain(FRIDGE_MENU_PROTOCOL);
    expect(prompt).toContain("カロリーや栄養素の数値を捏造しないでください");
    // The confirm-to-write sentinel the day-plan reuses is still advertised.
    expect(prompt).toContain(CALENDAR_PLAN_OPEN);
  });
});

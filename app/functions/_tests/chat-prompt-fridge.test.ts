import { describe, it, expect } from "vitest";
import {
  buildChatPrompt,
  formatFridgeAnalysis,
  AUTO_LOG_PROTOCOL,
  CALENDAR_PLAN_PROTOCOL,
  FRIDGE_MENU_PROTOCOL,
  SYSTEM_GUARDRAILS,
  COACH_EXPERTISE,
  type ChatContext,
  type ChatTurn,
} from "../_llm/chat-prompt";

// Phase2 (冷蔵庫の写真→献立提案). These prove the fridge feature is an ADDITIVE,
// anti-fabrication layer: it renders only identified ingredients, instructs the
// coach to use ONLY those + be honest about what's missing + route a chosen menu
// through the EXISTING meal-log/calendar blocks — and it never weakens the safety
// floor or the existing protocols.

const TURNS: ChatTurn[] = [{ role: "user", content: "これで何作れる？" }];

describe("formatFridgeAnalysis — renders only identified ingredients", () => {
  it("lists the ingredients with a 'these are all you have' framing (anti-fabrication)", () => {
    const block = formatFridgeAnalysis({
      ok: true,
      ingredients: [{ name: "卵", grams: 300 }, { name: "玉ねぎ" }],
    });
    expect(block).toContain("写真から見えた食材");
    expect(block).toContain("あなたが足した物ではありません");
    expect(block).toContain("・卵（約300g）");
    expect(block).toContain("・玉ねぎ"); // no grams when unknown
    expect(block).not.toContain("（約0g）");
  });

  it("ok:false → an honest 'ask, don't invent' instruction", () => {
    const block = formatFridgeAnalysis({ ok: false });
    expect(block).toContain("読み取れませんでした");
    expect(block).toContain("勝手に食材や献立を作らないこと");
  });

  it("ok:true but empty ingredients → ask what's there (don't fabricate)", () => {
    const block = formatFridgeAnalysis({ ok: true, ingredients: [] });
    expect(block).toContain("特定できませんでした");
    expect(block).toContain("勝手に足さない");
  });

  it("returns null when there is no fridge analysis (prompt omits the section)", () => {
    expect(formatFridgeAnalysis(undefined)).toBeNull();
  });
});

describe("FRIDGE_MENU_PROTOCOL — content + anti-fabrication framing", () => {
  it("instructs: use only listed ingredients, be honest about missing, no fixed kcal", () => {
    expect(FRIDGE_MENU_PROTOCOL).toContain("写っていない食材を勝手に「ある前提」で足さないこと");
    expect(FRIDGE_MENU_PROTOCOL).toContain("これには◯◯も必要です");
    // No fixed kcal/PFC in prose — defers to the existing no-fabrication floor.
    expect(FRIDGE_MENU_PROTOCOL).toContain("確定値として本文に断言しない");
  });

  it("routes a CHOSEN menu through the EXISTING meal-log / calendar blocks (not a new one)", () => {
    expect(FRIDGE_MENU_PROTOCOL).toContain("MEAL_LOG");
    expect(FRIDGE_MENU_PROTOCOL).toContain("CALENDAR_PLAN");
    expect(FRIDGE_MENU_PROTOCOL).toContain("提案しただけ・相談中のターンでは記録ブロックを出さない");
  });
});

describe("buildChatPrompt — fridge layer is additive, never weakens existing prompt", () => {
  it("always includes the fridge protocol (so a fridge photo can be handled any turn)", () => {
    const prompt = buildChatPrompt(TURNS);
    expect(prompt).toContain(FRIDGE_MENU_PROTOCOL);
    expect(prompt).toContain("【冷蔵庫の写真から献立を提案する（AIプランナー）】");
  });

  it("renders the fridge block ONLY when fridgeAnalysis is attached", () => {
    const withFridge: ChatContext = {
      fridgeAnalysis: { ok: true, ingredients: [{ name: "鶏むね肉", grams: 200 }] },
    };
    const prompt = buildChatPrompt(TURNS, withFridge);
    expect(prompt).toContain("【今送られた冷蔵庫・食材写真の解析】");
    expect(prompt).toContain("鶏むね肉");

    // No fridge analysis → the per-turn block is absent (but the protocol stays).
    const plain = buildChatPrompt(TURNS);
    expect(plain).not.toContain("【今送られた冷蔵庫・食材写真の解析】");
    expect(plain).toContain(FRIDGE_MENU_PROTOCOL);
  });

  it("the safety floor + existing protocols remain intact alongside the fridge layer", () => {
    const prompt = buildChatPrompt(TURNS, {
      fridgeAnalysis: { ok: true, ingredients: [{ name: "卵" }] },
    });
    expect(prompt).toContain(SYSTEM_GUARDRAILS);
    expect(prompt).toContain(COACH_EXPERTISE);
    expect(prompt).toContain(AUTO_LOG_PROTOCOL);
    expect(prompt).toContain(CALENDAR_PLAN_PROTOCOL);
    expect(prompt).toContain("カロリーや栄養素の数値を捏造しないでください");
  });
});

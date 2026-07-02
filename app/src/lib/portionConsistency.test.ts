// Cross-path portion consistency — the regression test for Ao's bug:
// "コーチに入れてもらった=8kcal、AI解析をかけたら=10kcal。同じ品目は同じ数字に
// ならないとダメ".
//
// Root cause: BOTH the coach (chat MEAL_LOG → foodGrounding.groundMealLogItem) and
// the AI photo/text analysis (functions/_lib/ground.groundDish) grounded a standard
// food against the SAME official DB row, but each path let the model freely guess
// the GRAMS for an unstated amount → divergent kcal for the SAME food.
//
// Fix: a SHARED standard-portion table (functions/_lib/standard-portions) both
// grounding layers call, so an unstated コーヒー lands on 200g on BOTH paths → the
// SAME kcal. These tests assert the two paths agree for the marquee items, and that
// a user-stated amount still wins on both (the table is only the unstated default).

import { describe, it, expect } from "vitest";
import { groundMealLogItem } from "./foodGrounding";
import { groundDish } from "../../functions/_lib/ground";
import {
  standardPortionGrams,
  resolveStandardGrams,
  DEFAULT_PORTION_G,
} from "../../functions/_lib/standard-portions";

/** The grams + kcal the COACH path (chat MEAL_LOG) logs for a name/grams. */
function coachGround(name: string, grams: number): { grams: number; kcal: number | null } {
  const it = groundMealLogItem({ name, grams, source: "db" });
  return { grams: it.grams, kcal: it.kcal };
}

/** The grams + kcal the AI-ANALYSIS path (photo/text) logs for a name/grams. */
function aiGround(name: string, grams: number): { grams: number; kcal: number | null } {
  const it = groundDish({ name, grams, source: "db" });
  return { grams: it.grams, kcal: it.kcal };
}

describe("standard-portions table — the shared source of truth", () => {
  it("returns the standard serving for a known drink/staple, null otherwise", () => {
    expect(standardPortionGrams("ブラックコーヒー")).toBe(200);
    expect(standardPortionGrams("コーヒー")).toBe(200);
    expect(standardPortionGrams("ごはん")).toBe(150);
    expect(standardPortionGrams("卵")).toBe(50);
    expect(standardPortionGrams("味噌汁")).toBe(200);
    expect(standardPortionGrams("プロテイン")).toBe(30);
    expect(standardPortionGrams("鶏むね肉 皮なし")).toBe(100);
    expect(standardPortionGrams("豚バラ")).toBe(80);
    expect(standardPortionGrams("さつまいも")).toBe(150);
    expect(standardPortionGrams("ハイボール")).toBe(350);
    // Not a named staple → no specific standard portion.
    expect(standardPortionGrams("謎の料理")).toBeNull();
  });

  it("normalizes the name so spacing / full-width / brackets still match", () => {
    expect(standardPortionGrams(" コーヒー ")).toBe(200);
    expect(standardPortionGrams("コーヒー（ホット）")).toBe(200); // bracket stripped
  });

  it("resolveStandardGrams keeps a stated amount and defaults only an unstated one", () => {
    // Stated amount (>0) is kept verbatim — the user's number always wins.
    expect(resolveStandardGrams("コーヒー", 250)).toEqual({ grams: 250, defaulted: false });
    // Unstated (0 / negative / NaN) → the food's standard portion.
    expect(resolveStandardGrams("コーヒー", 0)).toEqual({ grams: 200, defaulted: true });
    expect(resolveStandardGrams("コーヒー", -5)).toEqual({ grams: 200, defaulted: true });
    // Unknown food, unstated → the generic single-serving default.
    expect(resolveStandardGrams("謎の料理", 0)).toEqual({
      grams: DEFAULT_PORTION_G,
      defaulted: true,
    });
  });
});

describe("coach path === AI-analysis path (Ao's bug: 8 vs 10 must become the SAME number)", () => {
  it("ブラックコーヒー with NO stated amount → identical grams AND kcal on both paths", () => {
    const coach = coachGround("ブラックコーヒー", 0); // user just said "ブラックコーヒー"
    const ai = aiGround("ブラックコーヒー", 0); // AI解析 with no portion cue
    // Both land on the shared 1杯=200g standard…
    expect(coach.grams).toBe(200);
    expect(ai.grams).toBe(200);
    // …so both compute the SAME kcal from the SAME DB row (4kcal/100g × 200g = 8).
    expect(coach.kcal).toBe(8);
    expect(ai.kcal).toBe(8);
    expect(coach.kcal).toBe(ai.kcal); // the invariant Ao demanded
  });

  it("even if the AI path guessed a DIFFERENT raw portion, an UNSTATED amount converges", () => {
    // The whole point: when the user did NOT state an amount, the grams come from the
    // shared table, NOT a free guess — so the historical "coach 200g / AI 250g" split
    // can't happen for an unstated portion. (A 0/absent grams is the unstated signal.)
    expect(coachGround("コーヒー", 0).kcal).toBe(aiGround("コーヒー", 0).kcal);
    expect(coachGround("緑茶", 0).kcal).toBe(aiGround("緑茶", 0).kcal);
    expect(coachGround("味噌汁", 0).kcal).toBe(aiGround("味噌汁", 0).kcal);
  });

  it("the staples agree on both paths for an unstated amount", () => {
    for (const name of ["ごはん", "食パン", "卵", "バナナ", "納豆", "鶏むね肉", "さつまいも"]) {
      const coach = coachGround(name, 0);
      const ai = aiGround(name, 0);
      expect(coach.grams, `${name} grams`).toBe(ai.grams);
      expect(coach.kcal, `${name} kcal`).toBe(ai.kcal);
    }
  });

  it("a USER-STATED amount is honoured identically on both paths (table never overrides it)", () => {
    // The user explicitly said 250g of coffee → both paths use 250g → 10 kcal (same).
    const coach = coachGround("ブラックコーヒー", 250);
    const ai = aiGround("ブラックコーヒー", 250);
    expect(coach.grams).toBe(250);
    expect(ai.grams).toBe(250);
    expect(coach.kcal).toBe(10); // 4/100g × 250g
    expect(ai.kcal).toBe(10);
    expect(coach.kcal).toBe(ai.kcal);
  });
});

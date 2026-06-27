import { describe, it, expect } from "vitest";
import { sumIntake } from "./intake";
import type { Meal } from "./types";

function meal(overrides: Partial<Meal> = {}): Meal {
  return {
    id: Math.random().toString(36).slice(2),
    date: "2026-06-17",
    timestamp: "2026-06-17T08:00:00.000Z",
    type: "朝",
    text: "",
    ...overrides,
  };
}

describe("sumIntake", () => {
  it("returns all zeros for no meals (extra nutrients null — no data)", () => {
    expect(sumIntake([])).toEqual({
      calories: 0,
      proteinG: 0,
      fatG: 0,
      carbG: 0,
      fiberG: null,
      sugarG: null,
      sodiumMg: null,
      saturatedFatG: null,
      loggedCount: 0,
    });
  });

  it("ignores meals with no nutrition object", () => {
    const r = sumIntake([meal(), meal()]);
    expect(r.calories).toBe(0);
    expect(r.loggedCount).toBe(0);
  });

  it("ignores meals whose nutrition object is entirely empty", () => {
    const r = sumIntake([meal({ nutrition: {} })]);
    expect(r.loggedCount).toBe(0);
  });

  it("sums calories and PFC across meals, counting only logged ones", () => {
    const r = sumIntake([
      meal({ nutrition: { calories: 500, proteinG: 30, fatG: 15, carbG: 60 } }),
      meal({ nutrition: { calories: 700, proteinG: 40, fatG: 20, carbG: 80 } }),
      meal(), // no nutrition — ignored
    ]);
    expect(r).toEqual({
      calories: 1200,
      proteinG: 70,
      fatG: 35,
      carbG: 140,
      fiberG: null,
      sugarG: null,
      sodiumMg: null,
      saturatedFatG: null,
      loggedCount: 2,
    });
  });

  it("treats missing individual macros as zero but still counts the meal", () => {
    const r = sumIntake([meal({ nutrition: { calories: 300 } })]);
    expect(r).toEqual({
      calories: 300,
      proteinG: 0,
      fatG: 0,
      carbG: 0,
      fiberG: null,
      sugarG: null,
      sodiumMg: null,
      saturatedFatG: null,
      loggedCount: 1,
    });
  });

  it("sums extra nutrients only over meals that carry them (others stay null)", () => {
    const r = sumIntake([
      meal({ nutrition: { calories: 200, fiberG: 3, sodiumMg: 100 } }),
      meal({ nutrition: { calories: 150, fiberG: 2 } }), // no sodium → not fabricated
    ]);
    expect(r.fiberG).toBeCloseTo(5, 1); // 3 + 2
    expect(r.sodiumMg).toBe(100); // only the first meal had it
    expect(r.sugarG).toBeNull(); // no meal had sugar → null, not 0
    expect(r.saturatedFatG).toBeNull();
  });

  it("a day with no extra-nutrient figures keeps them null (no fabricated 0)", () => {
    const r = sumIntake([meal({ nutrition: { calories: 400, proteinG: 20 } })]);
    expect(r.calories).toBe(400);
    expect(r.fiberG).toBeNull();
    expect(r.sugarG).toBeNull();
    expect(r.sodiumMg).toBeNull();
    expect(r.saturatedFatG).toBeNull();
  });

  // AIプランナー 第3陣D — 食事プラン: a not-yet-eaten PLAN (status "planned") must
  // NOT inflate today's 摂取 until the user presses 「食べた」 (the twin of the
  // workout planned-exclusion). ABSENT/eaten status are counted unchanged.
  it("EXCLUDES not-yet-eaten planned meals from the intake total (anti-fabrication)", () => {
    const r = sumIntake([
      meal({ nutrition: { calories: 500, proteinG: 30, fatG: 15, carbG: 60 } }), // eaten (absent)
      meal({ status: "planned", nutrition: { calories: 700, proteinG: 40, fatG: 20, carbG: 80 } }),
    ]);
    // Only the eaten meal counts; the plan adds nothing.
    expect(r.calories).toBe(500);
    expect(r.proteinG).toBe(30);
    expect(r.loggedCount).toBe(1);
  });

  it("counts an explicitly EATEN meal (status 'eaten')", () => {
    const r = sumIntake([
      meal({ status: "eaten", nutrition: { calories: 600 } }),
      meal({ status: "planned", nutrition: { calories: 999 } }),
    ]);
    expect(r.calories).toBe(600);
    expect(r.loggedCount).toBe(1);
  });

  it("a planned meal's extra nutrients are excluded too (no fabricated planned fiber)", () => {
    const r = sumIntake([
      meal({ status: "planned", nutrition: { calories: 300, fiberG: 5 } }),
    ]);
    expect(r.calories).toBe(0);
    expect(r.fiberG).toBeNull(); // the plan's fiber never counts
    expect(r.loggedCount).toBe(0);
  });
});

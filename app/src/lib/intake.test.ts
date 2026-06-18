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
  it("returns all zeros for no meals", () => {
    expect(sumIntake([])).toEqual({
      calories: 0,
      proteinG: 0,
      fatG: 0,
      carbG: 0,
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
      loggedCount: 1,
    });
  });
});

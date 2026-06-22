import { describe, it, expect } from "vitest";
import { suggestNext } from "./suggest";
import type { IntakeTotals } from "./intake";
import type { NutritionTargets } from "./types";

const targets: NutritionTargets = {
  bmr: 1780,
  tdee: 2759,
  calories: 2759,
  proteinG: 144,
  fatG: 77,
  carbG: 373,
  bmrMethod: "Mifflin-St Jeor",
};

function intake(overrides: Partial<IntakeTotals> = {}): IntakeTotals {
  return {
    calories: 0,
    proteinG: 0,
    fatG: 0,
    carbG: 0,
    fiberG: null,
    sugarG: null,
    sodiumMg: null,
    saturatedFatG: null,
    loggedCount: 0,
    ...overrides,
  };
}

describe("suggestNext", () => {
  it("prioritises protein when multiple macros are short", () => {
    const s = suggestNext(intake(), targets);
    expect(s.macro).toBe("protein");
    expect(s.remaining).toBe(144);
    expect(s.message).toContain("タンパク質");
  });

  it("suggests carbs when protein is met but carbs are short", () => {
    const s = suggestNext(intake({ proteinG: 200, fatG: 100 }), targets);
    expect(s.macro).toBe("carb");
    expect(s.message).toContain("炭水化物");
  });

  it("suggests fat when only fat is short", () => {
    const s = suggestNext(intake({ proteinG: 200, carbG: 400 }), targets);
    expect(s.macro).toBe("fat");
    expect(s.message).toContain("脂質");
  });

  it("returns a done message when all targets are met", () => {
    const s = suggestNext(
      intake({ calories: 2800, proteinG: 150, fatG: 80, carbG: 380 }),
      targets,
    );
    expect(s.macro).toBeNull();
    expect(s.message).toContain("達成");
  });

  it("nudges on calories when PFC are met but calories remain", () => {
    // PFC met exactly, but calories well under (artificial but valid edge).
    const s = suggestNext(
      intake({ calories: 1000, proteinG: 144, fatG: 77, carbG: 373 }),
      targets,
    );
    expect(s.macro).toBe("calories");
    expect(s.message).toContain("kcal");
  });
});

import { describe, it, expect } from "vitest";
import { isMealPlanned, isMealEaten, eatenMeals } from "./mealStatus";
import type { Meal } from "./types";

function meal(id: string, status?: Meal["status"]): Meal {
  return {
    id,
    date: "2026-06-26",
    timestamp: "2026-06-26T08:00:00Z",
    type: "朝",
    text: id,
    ...(status ? { status } : {}),
  };
}

describe("meal plan/eaten boundary (ABSENT status → eaten, the anti-fabrication contract)", () => {
  it("isMealPlanned is true ONLY for explicit 'planned'", () => {
    expect(isMealPlanned(meal("a", "planned"))).toBe(true);
    expect(isMealPlanned(meal("b", "eaten"))).toBe(false);
    expect(isMealPlanned(meal("c"))).toBe(false); // ABSENT → eaten
  });

  it("isMealEaten is the exact inverse (ABSENT → eaten)", () => {
    expect(isMealEaten(meal("a", "planned"))).toBe(false);
    expect(isMealEaten(meal("b", "eaten"))).toBe(true);
    expect(isMealEaten(meal("c"))).toBe(true); // ABSENT → eaten
  });

  it("eatenMeals drops planned, keeps eaten + pre-feature (absent) meals", () => {
    const kept = eatenMeals([
      meal("plan", "planned"),
      meal("eaten", "eaten"),
      meal("legacy"),
    ]);
    expect(kept.map((m) => m.id)).toEqual(["eaten", "legacy"]);
  });
});

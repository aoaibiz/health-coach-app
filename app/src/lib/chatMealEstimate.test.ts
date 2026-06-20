import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Meal, MealItem } from "./types";

// Mock the network layer (analyzeMeal) so the test is offline + deterministic.
vi.mock("./analyzeMeal", () => ({
  hasApiKey: vi.fn(() => true),
  estimateSingleItem: vi.fn(),
}));

import { estimateLoggedMeal, itemNeedsEstimate } from "./chatMealEstimate";
import { estimateSingleItem, hasApiKey } from "./analyzeMeal";

const dbItem: MealItem = {
  id: "db1", name: "鶏胸肉", grams: 100, qty: 1,
  kcal: 108, proteinG: 22, fatG: 1.5, carbG: 0,
  sourceKind: "db", source: "公式DB", confidence: "high",
} as MealItem;

const missItem: MealItem = {
  id: "m1", name: "カツオのタタキ", grams: 100, qty: 1,
  kcal: null, proteinG: null, fatG: null, carbG: null,
  sourceKind: "estimate", source: "推定値", confidence: "low",
} as MealItem;

function meal(items: MealItem[]): Meal {
  return { id: "meal1", date: "2026-06-20", timestamp: "2026-06-20T08:00:00Z", type: "夕", text: "x", nutrition: { items } } as Meal;
}

describe("itemNeedsEstimate", () => {
  it("flags only DB-miss no-number 推定値 rows", () => {
    expect(itemNeedsEstimate(missItem)).toBe(true);
    expect(itemNeedsEstimate(dbItem)).toBe(false);
    expect(itemNeedsEstimate({ ...missItem, kcal: 50 } as MealItem)).toBe(false); // already has a number
  });
});

describe("estimateLoggedMeal", () => {
  beforeEach(() => {
    vi.mocked(hasApiKey).mockReturnValue(true);
    vi.mocked(estimateSingleItem).mockReset();
  });

  it("fills a DB-miss item with the AI estimate and recomputes nutrition", async () => {
    vi.mocked(estimateSingleItem).mockResolvedValue({
      ...missItem, kcal: 150, proteinG: 25, fatG: 4, carbG: 1,
    } as MealItem);
    const meals = [meal([dbItem, missItem])];
    const out = await estimateLoggedMeal(meals, "meal1");
    const filled = out[0].nutrition!.items!.find((i) => i.id === "m1")!;
    expect(filled.kcal).toBe(150);
    expect(out[0].nutrition!.calories).toBeGreaterThan(108); // total now includes the estimate
    expect(out).not.toBe(meals); // new array (immutability)
  });

  it("leaves the honest no-number row untouched when there is no API key", async () => {
    vi.mocked(hasApiKey).mockReturnValue(false);
    const meals = [meal([missItem])];
    const out = await estimateLoggedMeal(meals, "meal1");
    expect(out).toBe(meals); // unchanged reference
    expect(estimateSingleItem).not.toHaveBeenCalled();
  });

  it("keeps the no-number row when the estimate fails / declines (no fabrication)", async () => {
    vi.mocked(estimateSingleItem).mockResolvedValue(null);
    const meals = [meal([missItem])];
    const out = await estimateLoggedMeal(meals, "meal1");
    expect(out).toBe(meals);
    expect(out[0].nutrition!.items![0].kcal).toBeNull();
  });

  it("does nothing when all items already have numbers", async () => {
    const meals = [meal([dbItem])];
    const out = await estimateLoggedMeal(meals, "meal1");
    expect(out).toBe(meals);
    expect(estimateSingleItem).not.toHaveBeenCalled();
  });

  it("estimates the EFFECTIVE portion (per-unit grams × qty)", async () => {
    vi.mocked(estimateSingleItem).mockResolvedValue({
      ...missItem, name: "プロテイン", grams: 60, kcal: 240, proteinG: 48, fatG: 2, carbG: 6,
    } as MealItem);
    const meals = [meal([{ ...missItem, name: "プロテイン", grams: 30, qty: 2 } as MealItem])];
    const out = await estimateLoggedMeal(meals, "meal1");
    // grams 30 × qty 2 → estimate is requested for 60g (the full portion).
    expect(vi.mocked(estimateSingleItem)).toHaveBeenCalledWith("m1", "プロテイン", 60);
    expect(out[0].nutrition!.items![0].kcal).toBe(240);
  });
});

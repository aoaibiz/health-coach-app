import { describe, it, expect } from "vitest";
import {
  effectiveGrams,
  itemsToNutrition,
  presetsForName,
  recomputeItem,
  setItemGrams,
  setItemQty,
  toMealItem,
} from "./mealItems";
import { groundManualItem } from "./foodGrounding";
import type { MealItem } from "./types";

// Real MEXT per-100g rows used below (from functions/_data/nutrition-lookup.json):
//   ごはん (01088 こめ 水稲めし 精白米 うるち米): 156 / 2.5 / 0.3 / 37.1
//   卵     (12004 鶏卵 全卵 生):                  142 / 12.2 / 10.2 / 0.4

/** A db item with the official ごはん per-100g basis, 150g at qty 1. */
function dbRice(grams = 150): MealItem {
  return toMealItem({
    id: "rice",
    name: "ごはん",
    grams,
    kcal: null,
    proteinG: null,
    fatG: null,
    carbG: null,
    sourceKind: "db",
    source: "日本食品標準成分表（八訂）増補2023年から引用",
    confidence: "high",
    foodCode: "01088",
    basisPer100g: { foodCode: "01088", kcal: 156, proteinG: 2.5, fatG: 0.3, carbG: 37.1 },
  });
}

/** An estimate item: model said 100g = 290kcal / 16P / 20F / 12C (唐揚げ). */
function estimateKaraage(grams = 100): MealItem {
  return toMealItem({
    id: "karaage",
    name: "唐揚げ",
    grams,
    kcal: 290,
    proteinG: 16,
    fatG: 20,
    carbG: 12,
    sourceKind: "estimate",
    source: "推定値",
    confidence: "low",
  });
}

describe("recomputeItem — db items recompute from the DB per-100g (anti-fabrication)", () => {
  it("db item: doubling grams doubles kcal/PFC, computed from the DB basis", () => {
    const base = dbRice(150); // 156/100 * 150 = 234
    expect(base.kcal).toBe(234);
    expect(base.proteinG).toBe(3.8); // 2.5*1.5 = 3.75 → round1 3.8
    expect(base.fatG).toBe(0.5); // 0.3*1.5 = 0.45 → 0.5
    expect(base.carbG).toBe(55.7); // 37.1*1.5 = 55.65 → 55.7

    const doubled = setItemGrams(base, 300); // 156/100 * 300 = 468
    expect(doubled.kcal).toBe(468); // exactly 2× the 234, from the DB basis
    expect(doubled.proteinG).toBe(7.5); // 2.5*3 = 7.5
    expect(doubled.carbG).toBe(111.3); // 37.1*3 = 111.3
  });

  it("db recompute uses the DB basis, NOT the (absent) model number", () => {
    // The db item never carries a model kcal; its number is purely DB×grams/100.
    const base = dbRice(100);
    expect(base.kcal).toBe(156); // 156/100 * 100
    expect(base.basisPer100g?.kcal).toBe(156);
    const tripled = setItemGrams(base, 300);
    expect(tripled.kcal).toBe(468); // 156 * 3
    expect(tripled.sourceKind).toBe("db"); // stays 公式DB
  });

  it("db item ×qty multiplies the effective weight and kcal", () => {
    const base = dbRice(150); // 234 kcal at qty 1
    const twoBowls = setItemQty(base, 2); // 2杯 → 300g
    expect(effectiveGrams(twoBowls)).toBe(300);
    expect(twoBowls.kcal).toBe(468); // 234 × 2
    expect(twoBowls.qty).toBe(2);
  });
});

describe("recomputeItem — estimate/label items scale PROPORTIONALLY + stay labelled", () => {
  it("estimate item: grams ×2 → kcal ×2 by proportion (newKcal = base × g/baseG)", () => {
    const base = estimateKaraage(100); // 290 kcal at 100g
    expect(base.kcal).toBe(290);
    const doubled = setItemGrams(base, 200); // 290 × 200/100 = 580
    expect(doubled.kcal).toBe(580);
    expect(doubled.proteinG).toBe(32); // 16 × 2
    expect(doubled.fatG).toBe(40); // 20 × 2
    expect(doubled.sourceKind).toBe("estimate"); // NEVER promoted to db
  });

  it("estimate item: half the grams halves the numbers, still 推定値", () => {
    const base = estimateKaraage(100);
    const half = setItemGrams(base, 50); // 290 × 0.5 = 145
    expect(half.kcal).toBe(145);
    expect(half.proteinG).toBe(8);
    expect(half.sourceKind).toBe("estimate");
    expect(half.source).toBe("推定値");
  });

  it("label item scales proportionally and stays ラベル値", () => {
    const label = toMealItem({
      id: "protein",
      name: "プロテイン",
      grams: 30,
      kcal: 120,
      proteinG: 24,
      fatG: 1.5,
      carbG: 2,
      sourceKind: "label",
      source: "ラベル値",
      confidence: "medium",
    });
    const twoScoops = setItemQty(label, 2); // 30g → 60g, 120 × 2 = 240
    expect(effectiveGrams(twoScoops)).toBe(60);
    expect(twoScoops.kcal).toBe(240);
    expect(twoScoops.proteinG).toBe(48);
    expect(twoScoops.sourceKind).toBe("label");
  });
});

describe("itemsToNutrition — add / remove updates the total live", () => {
  it("sums kcal/PFC across items and derives the source flags", () => {
    const items = [dbRice(150), estimateKaraage(100)];
    const n = itemsToNutrition(items);
    expect(n.calories).toBe(524); // 234 + 290
    expect(n.proteinG).toBe(19.8); // 3.8 + 16
    expect(n.estimated).toBe(true); // includes an estimate
    expect(n.sourceKind).toBe("estimate"); // dominant kind
    expect(n.items).toHaveLength(2);
  });

  it("removing the estimate item drops the total and makes it pure 公式DB", () => {
    const items = [dbRice(150), estimateKaraage(100)];
    const afterRemove = items.filter((i) => i.id !== "karaage");
    const n = itemsToNutrition(afterRemove);
    expect(n.calories).toBe(234); // only the rice remains
    expect(n.estimated).toBe(false);
    expect(n.sourceKind).toBe("db");
  });

  it("adding an item raises the total", () => {
    const before = itemsToNutrition([dbRice(150)]);
    const after = itemsToNutrition([dbRice(150), dbRice(150)]);
    expect(before.calories).toBe(234);
    expect(after.calories).toBe(468); // two bowls
  });
});

describe("groundManualItem — manual add grounds against the DB like analysis", () => {
  it("a DB-known name becomes a 公式DB item with the per-100g basis", () => {
    const item = groundManualItem("m1", "ごはん", 150);
    expect(item.sourceKind).toBe("db");
    expect(item.basisPer100g?.kcal).toBe(156);
    expect(item.kcal).toBe(234); // 156/100 × 150, from the DB
    // And it then recomputes from the DB on edit (anti-fabrication intact).
    expect(setItemGrams(item, 300).kcal).toBe(468);
  });

  it("an unknown name becomes an honest 推定値 item with no fabricated number", () => {
    const item = groundManualItem("m2", "謎の宇宙料理ゼノモーフ", 200);
    expect(item.sourceKind).toBe("estimate");
    expect(item.kcal).toBeNull(); // nothing to ground → no invented number
  });
});

describe("presets — a preset sets the item grams", () => {
  it("ごはん presets exist and applying one sets grams (and recomputes)", () => {
    const presets = presetsForName("ごはん");
    expect(presets.length).toBeGreaterThan(0);
    const oomori = presets.find((p) => p.grams === 250);
    expect(oomori).toBeTruthy();

    const item = dbRice(150);
    const applied = setItemGrams(item, oomori!.grams); // 大盛 250g
    expect(applied.grams).toBe(250);
    expect(applied.kcal).toBe(390); // 156/100 × 250
  });

  it("食パン / 卵 presets resolve; an unknown food has none", () => {
    expect(presetsForName("食パン").some((p) => p.grams === 60)).toBe(true);
    expect(presetsForName("卵").some((p) => p.grams === 50)).toBe(true);
    expect(presetsForName("カレーライス")).toEqual([]);
  });
});

describe("recompute keeps numbers in sync without mutating the input", () => {
  it("recomputeItem returns a fresh object (no mutation)", () => {
    const base = dbRice(150);
    const next = recomputeItem({ ...base, grams: 300 });
    expect(base.grams).toBe(150); // original untouched
    expect(next.kcal).toBe(468);
  });
});

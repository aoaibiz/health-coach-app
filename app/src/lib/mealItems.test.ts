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
import { groundManualItem, groundMealLogItem } from "./foodGrounding";
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

describe("ANTI-FABRICATION — chat→食事 estimate keeps unmeasured PFC null (not 0)", () => {
  it("a kcal-only estimate logs PFC as null, never a fabricated 0", () => {
    // The coach's block carried only a kcal (no macros). The grounded item must
    // keep protein/fat/carb null so the card shows "—", not a fake 0g.
    const item = groundMealLogItem({
      name: "屋台のたい焼き",
      grams: 100,
      source: "estimate",
      kcal: 210,
    });
    expect(item.sourceKind).toBe("estimate");
    expect(item.kcal).toBe(210);
    expect(item.proteinG).toBeNull();
    expect(item.fatG).toBeNull();
    expect(item.carbG).toBeNull();
  });

  it("itemsToNutrition sums PFC only over items that have them (no 0 from kcal-only)", () => {
    // One estimate has kcal + protein; the other has kcal only. Protein total =
    // JUST the first's protein (kcal-only item must not add a 0), and fat/carb are
    // null (no contributing item carried them) → shown as "—".
    const withProtein = groundMealLogItem({
      name: "焼き菓子A",
      grams: 100,
      source: "estimate",
      kcal: 200,
      protein_g: 5,
    });
    const kcalOnly = groundMealLogItem({
      name: "焼き菓子B",
      grams: 100,
      source: "estimate",
      kcal: 150,
    });
    const n = itemsToNutrition([withProtein, kcalOnly]);
    expect(n.calories).toBe(350);
    expect(n.proteinG).toBe(5); // only A's protein, NOT 5 + 0
    expect(n.fatG).toBeNull(); // neither carried fat → "—", not 0
    expect(n.carbG).toBeNull();
  });

  it("a meal of ONLY kcal-only estimates reports PFC totals as null", () => {
    const a = groundMealLogItem({ name: "謎A", grams: 100, source: "estimate", kcal: 120 });
    const b = groundMealLogItem({ name: "謎B", grams: 100, source: "estimate", kcal: 80 });
    const n = itemsToNutrition([a, b]);
    expect(n.calories).toBe(200);
    expect(n.proteinG).toBeNull();
    expect(n.fatG).toBeNull();
    expect(n.carbG).toBeNull();
  });

  it("a db meal still reports real PFC totals (the null rule never hides DB numbers)", () => {
    const n = itemsToNutrition([dbRice(150)]);
    expect(n.calories).toBe(234);
    expect(n.proteinG).toBe(3.8); // 2.5 × 1.5, a real number (not null)
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

describe("extra nutrients (全栄養素) — recompute + sum, with honest nulls", () => {
  /** A db item carrying extra nutrients in its per-100g basis (saturated null). */
  function dbRiceFull(grams = 150): MealItem {
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
      basisPer100g: {
        foodCode: "01088",
        kcal: 156,
        proteinG: 2.5,
        fatG: 0.3,
        carbG: 37.1,
        fiberG: 1.5,
        sugarG: 38.1,
        sodiumMg: 1,
        saturatedFatG: null, // not in the table
      },
    });
  }

  it("db item scales the extra nutrients from the basis; saturated stays null", () => {
    const base = dbRiceFull(100);
    expect(base.fiberG).toBeCloseTo(1.5, 1);
    expect(base.sugarG).toBeCloseTo(38.1, 1);
    expect(base.sodiumMg).toBeCloseTo(1, 1);
    expect(base.saturatedFatG).toBeNull();
    const doubled = setItemGrams(base, 200);
    expect(doubled.fiberG).toBeCloseTo(3, 1); // 1.5 × 2
    expect(doubled.sodiumMg).toBeCloseTo(2, 1); // 1 × 2
    expect(doubled.saturatedFatG).toBeNull(); // still no figure (never fabricated)
  });

  it("label/estimate item scales its extra anchors proportionally; missing stays null", () => {
    const bar = toMealItem({
      id: "bar",
      name: "プロテインバー",
      grams: 50,
      kcal: 200,
      proteinG: 20,
      fatG: 6,
      carbG: 20,
      fiberG: 5,
      sodiumMg: 150,
      // sugar + saturated omitted → null
      sourceKind: "label",
      source: "ラベル値",
      confidence: "medium",
    });
    expect(bar.fiberG).toBe(5);
    expect(bar.sodiumMg).toBe(150);
    expect(bar.sugarG).toBeNull(); // omitted → null, not 0
    expect(bar.saturatedFatG).toBeNull();
    const doubled = setItemGrams(bar, 100);
    expect(doubled.fiberG).toBe(10); // 5 × 2
    expect(doubled.sodiumMg).toBe(300); // 150 × 2
    expect(doubled.sugarG).toBeNull(); // still null after scaling
  });

  it("itemsToNutrition sums extras only over items that carry them; null when none", () => {
    const rice = dbRiceFull(100); // fiber 1.5, sodium 1, no saturated
    const bar = toMealItem({
      id: "bar",
      name: "プロテインバー",
      grams: 50,
      kcal: 200,
      proteinG: 20,
      fatG: 6,
      carbG: 20,
      fiberG: 5,
      saturatedFatG: 3,
      sourceKind: "label",
      source: "ラベル値",
      confidence: "medium",
    });
    const total = itemsToNutrition([rice, bar]);
    expect(total.fiberG).toBeCloseTo(6.5, 1); // 1.5 + 5
    expect(total.saturatedFatG).toBe(3); // only the bar had it
  });

  it("itemsToNutrition: a meal with NO extra-nutrient figures → those totals null", () => {
    const estimateOnly = estimateKaraage(100); // no extras supplied
    const total = itemsToNutrition([estimateOnly]);
    expect(total.calories).toBe(290);
    expect(total.fiberG).toBeNull();
    expect(total.sugarG).toBeNull();
    expect(total.sodiumMg).toBeNull();
    expect(total.saturatedFatG).toBeNull();
  });
});

describe("vitamins/minerals (拡張①) — recompute + sum, with honest nulls", () => {
  /** A db item whose per-100g basis carries a micros map (iron measured, B12 null). */
  function dbWithMicros(grams = 100): MealItem {
    return toMealItem({
      id: "veg",
      name: "ほうれんそう",
      grams,
      kcal: null,
      proteinG: null,
      fatG: null,
      carbG: null,
      sourceKind: "db",
      source: "日本食品標準成分表（八訂）増補2023年から引用",
      confidence: "high",
      foodCode: "06267",
      basisPer100g: {
        foodCode: "06267",
        kcal: 18,
        proteinG: 2.2,
        fatG: 0.4,
        carbG: 3.1,
        micros: { iron: 2.0, vitaminC: 35, vitaminB12: null },
      },
    });
  }

  it("db item scales the micros from the basis; an unmeasured micro stays null", () => {
    const base = dbWithMicros(100);
    expect(base.micros?.iron).toBeCloseTo(2.0, 1);
    expect(base.micros?.vitaminC).toBeCloseTo(35, 1);
    expect(base.micros?.vitaminB12).toBeNull(); // unmeasured → null, never 0
    const doubled = setItemGrams(base, 200);
    expect(doubled.micros?.iron).toBeCloseTo(4.0, 1); // 2 × 2
    expect(doubled.micros?.vitaminC).toBeCloseTo(70, 1);
    expect(doubled.micros?.vitaminB12).toBeNull();
  });

  it("label/estimate item scales its anchor micros proportionally", () => {
    const supp = toMealItem({
      id: "supp",
      name: "鉄サプリ",
      grams: 1,
      kcal: 0,
      proteinG: 0,
      fatG: 0,
      carbG: 0,
      micros: { iron: 10 },
      sourceKind: "label",
      source: "ラベル値",
      confidence: "medium",
    });
    expect(supp.micros?.iron).toBe(10);
    const doubled = setItemGrams(supp, 2);
    expect(doubled.micros?.iron).toBeCloseTo(20, 1); // 10 × 2 (grams/baseGrams)
  });

  it("itemsToNutrition sums micros only over items that carry them; null when none", () => {
    const veg = dbWithMicros(100); // iron 2, vitaminC 35
    const supp = toMealItem({
      id: "supp",
      name: "鉄サプリ",
      grams: 1,
      kcal: 0,
      proteinG: 0,
      fatG: 0,
      carbG: 0,
      micros: { iron: 10 },
      sourceKind: "label",
      source: "ラベル値",
      confidence: "medium",
    });
    const total = itemsToNutrition([veg, supp]);
    expect(total.micros?.iron).toBeCloseTo(12, 1); // 2 + 10
    expect(total.micros?.vitaminC).toBeCloseTo(35, 1); // only veg had it
    // a micro NO item carried stays null (not a fabricated 0).
    expect(total.micros?.calcium).toBeNull();
  });

  it("a meal with NO micros → meal micros undefined (panel hidden)", () => {
    const estimateOnly = estimateKaraage(100);
    const total = itemsToNutrition([estimateOnly]);
    expect(total.micros).toBeUndefined();
  });
});

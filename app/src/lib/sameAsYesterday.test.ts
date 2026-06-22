import { describe, it, expect } from "vitest";
import {
  explicitSlot,
  findYesterdayMeal,
  inferSlotFromHour,
  isSameAsYesterday,
  resolveSameAsYesterday,
  sameAsYesterdayConfirmation,
} from "./sameAsYesterday";
import type { Meal, MealItem } from "./types";

// "昨日と同じ量" must REUSE yesterday's actual logged meal (copy items + grams +
// kcal/PFC verbatim) and log it for today — never re-ask, never fabricate. These
// tests pin: (1) intent detection, (2) slot selection, (3) the verbatim copy, and
// (4) the no-record fallback (the ONLY case that returns null → caller asks).

/** Build a db MealItem with a real number (mirrors a grounded log). */
function dbItem(name: string, grams: number, kcal: number): MealItem {
  return {
    id: `src-${name}`,
    name,
    grams,
    qty: 1,
    kcal,
    proteinG: 5,
    fatG: 2,
    carbG: 30,
    sourceKind: "db",
    source: "公式DB",
    confidence: "high",
    basisPer100g: { kcal: kcal, proteinG: 5, fatG: 2, carbG: 30 },
  };
}

// Dates are keyed by the user's LOCAL calendar day (date.ts toDateKey/getHours),
// so the tests build local-time dates — never a UTC literal whose local day/hour
// would shift with the runner's timezone. "today" = 2026-06-19, "yesterday" = 18.
const todayLunch = new Date(2026, 5, 19, 12, 30); // local 2026-06-19 12:30
const todayDinner = new Date(2026, 5, 19, 19, 0); // local 2026-06-19 19:00
const todayMorning = new Date(2026, 5, 19, 8, 0); // local 2026-06-19 08:00
/** A local-time ISO timestamp for a yesterday meal at the given local hour. */
function yTs(hour: number): string {
  return new Date(2026, 5, 18, hour, 0).toISOString();
}

/** A yesterday meal (2026-06-18) for the given slot with one item. */
function yMeal(type: Meal["type"], items: MealItem[], ts = yTs(12)): Meal {
  const calories = items.reduce((a, i) => a + (i.kcal ?? 0), 0);
  return {
    id: `y-${type}`,
    date: "2026-06-18",
    timestamp: ts,
    type,
    text: items.map((i) => i.name).join("、"),
    nutrition: {
      calories,
      proteinG: 5,
      fatG: 2,
      carbG: 30,
      sourceKind: "db",
      estimated: false,
      items,
    },
  };
}

describe("isSameAsYesterday — intent detection (yesterday AND sameness)", () => {
  it("matches the common phrasings", () => {
    expect(isSameAsYesterday("昨日と同じ量")).toBe(true);
    expect(isSameAsYesterday("きのうと同じでお願いします")).toBe(true);
    expect(isSameAsYesterday("昨日と一緒のやつ")).toBe(true);
    expect(isSameAsYesterday("昨日の朝ごはんと同じ")).toBe(true);
    expect(isSameAsYesterday("前日と同様に登録して")).toBe(true);
  });

  it("does NOT match a sentence merely mentioning 昨日 (no sameness word)", () => {
    expect(isSameAsYesterday("昨日は食べすぎた")).toBe(false);
    expect(isSameAsYesterday("昨日のことだけど")).toBe(false);
  });

  it("does NOT match sameness without a yesterday reference", () => {
    expect(isSameAsYesterday("いつもと同じで")).toBe(false);
    expect(isSameAsYesterday("")).toBe(false);
  });
});

describe("slot selection (explicit name, else inferred from the hour)", () => {
  it("reads an explicitly named slot", () => {
    expect(explicitSlot("昨日の朝ごはんと同じ")).toBe("朝");
    expect(explicitSlot("昨日のランチと同じ")).toBe("昼");
    expect(explicitSlot("昨日の夕食と同じ")).toBe("夕");
    expect(explicitSlot("昨日のおやつと同じ")).toBe("間食");
    expect(explicitSlot("昨日と同じ量")).toBeNull(); // no slot named
  });

  it("infers a slot from the local hour when none is named", () => {
    expect(inferSlotFromHour(8)).toBe("朝");
    expect(inferSlotFromHour(12)).toBe("昼");
    expect(inferSlotFromHour(19)).toBe("夕");
    expect(inferSlotFromHour(2)).toBe("間食"); // late night → 間食
    expect(inferSlotFromHour(23)).toBe("間食");
  });
});

describe("findYesterdayMeal — picks the right record (or null)", () => {
  const meals: Meal[] = [
    yMeal("朝", [dbItem("ごはん", 150, 234)]),
    yMeal("昼", [dbItem("鶏むね肉", 100, 108)]),
    // a same-slot meal with NO item breakdown (last resort), plus the real one
    {
      id: "y-empty-昼",
      date: "2026-06-18",
      timestamp: yTs(11),
      type: "昼",
      text: "メモだけ",
      nutrition: undefined,
    },
  ];

  it("returns yesterday's meal for the slot, preferring one with items", () => {
    const m = findYesterdayMeal(meals, "2026-06-18", "昼");
    expect(m?.id).toBe("y-昼"); // the one WITH items, not the empty memo
  });

  it("returns null when yesterday has no meal for that slot", () => {
    expect(findYesterdayMeal(meals, "2026-06-18", "間食")).toBeNull();
  });

  it("does not match a different date", () => {
    expect(findYesterdayMeal(meals, "2026-06-17", "朝")).toBeNull();
  });
});

describe("resolveSameAsYesterday — the marquee fix: reuse, don't re-ask", () => {
  const now = todayLunch; // local 2026-06-19 12:30
  const meals: Meal[] = [
    yMeal("朝", [dbItem("ごはん", 150, 234), dbItem("卵", 50, 71)]),
    yMeal("昼", [dbItem("親子丼", 400, 650)]),
  ];

  it("copies yesterday's lunch VERBATIM into a new TODAY meal (no fabrication)", () => {
    const r = resolveSameAsYesterday("昨日と同じ量", meals, now);
    expect(r).not.toBeNull();
    expect(r!.slot).toBe("昼"); // inferred from the 12:30 hour
    // New meal lands on TODAY with a fresh id + now-timestamp.
    expect(r!.meal.date).toBe("2026-06-19");
    expect(r!.meal.id).not.toBe(r!.source.id);
    expect(r!.meal.timestamp).toBe(now.toISOString());
    expect(r!.meal.type).toBe("昼");
    // The numbers are yesterday's OWN — copied, not recomputed/invented.
    expect(r!.meal.nutrition?.calories).toBe(650);
    expect(r!.meal.nutrition?.items).toHaveLength(1);
    const item = r!.meal.nutrition!.items![0];
    expect(item.name).toBe("親子丼");
    expect(item.grams).toBe(400);
    expect(item.kcal).toBe(650);
    // Item gets a fresh id (so it's editable independently) but same numbers.
    expect(item.id).not.toBe("src-親子丼");
    // No photo on a text-driven re-log.
    expect(r!.meal.photoId).toBeUndefined();
  });

  it("honours an explicitly named slot over the inferred one", () => {
    const r = resolveSameAsYesterday("昨日の朝ごはんと同じでお願いします", meals, now);
    expect(r!.slot).toBe("朝");
    expect(r!.meal.nutrition?.items?.map((i) => i.name)).toEqual(["ごはん", "卵"]);
    expect(r!.meal.nutrition?.calories).toBe(234 + 71);
  });

  it("returns null when yesterday has NO record for the slot (caller then asks)", () => {
    // Dinner-time today, but yesterday has no 夕 record → null → fall through to LLM.
    const r = resolveSameAsYesterday("昨日と同じ量", meals, todayDinner);
    expect(r).toBeNull();
  });

  it("returns null for a non-'same as yesterday' message (no false trigger)", () => {
    expect(resolveSameAsYesterday("昨日は焼肉だった", meals, now)).toBeNull();
    expect(resolveSameAsYesterday("ごはん150g食べた", meals, now)).toBeNull();
  });

  it("a label/estimate meal is reused verbatim too, staying flagged 推定", () => {
    const estMeal: Meal = {
      id: "y-est",
      date: "2026-06-18",
      timestamp: yTs(12),
      type: "昼",
      text: "コンビニ唐揚げ",
      nutrition: {
        calories: 290,
        sourceKind: "estimate",
        estimated: true,
        items: [
          {
            id: "src-kara",
            name: "コンビニ唐揚げ",
            grams: 100,
            qty: 1,
            kcal: 290,
            proteinG: 16,
            fatG: 18,
            carbG: 12,
            sourceKind: "estimate",
            source: "推定値",
            confidence: "low",
            baseGrams: 100,
            baseKcal: 290,
          },
        ],
      },
    };
    const r = resolveSameAsYesterday("昨日のお昼と同じ", [estMeal], now);
    expect(r!.meal.nutrition?.estimated).toBe(true);
    expect(r!.meal.nutrition?.sourceKind).toBe("estimate");
    expect(r!.meal.nutrition?.items?.[0].kcal).toBe(290); // copied, not re-grounded
  });
});

describe("sameAsYesterdayConfirmation — honest, shows what was logged", () => {
  it("states the slot, items, and the reused calorie total", () => {
    const meals = [yMeal("朝", [dbItem("ごはん", 150, 234), dbItem("卵", 50, 71)])];
    const r = resolveSameAsYesterday("昨日の朝と同じ", meals, todayMorning)!;
    const msg = sameAsYesterdayConfirmation(r);
    expect(msg).toContain("朝食");
    expect(msg).toContain("ごはん");
    expect(msg).toContain("卵");
    expect(msg).toContain("305kcal"); // 234 + 71, the reused total
    expect(msg).toContain("記録"); // tells the user it WAS logged
  });
});

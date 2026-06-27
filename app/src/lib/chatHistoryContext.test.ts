import { describe, it, expect } from "vitest";
import { buildRecentDays, todaySleepSummary } from "./chatHistoryContext";
import type { Meal, SleepLog, Workout } from "./types";

function meal(date: string, kcal: number): Meal {
  return {
    id: `${date}-${kcal}-${Math.random()}`,
    date,
    timestamp: `${date}T08:00:00.000Z`,
    type: "朝",
    text: "",
    nutrition: { calories: kcal },
  };
}

function sleep(date: string, bedtime: string, wakeTime: string): SleepLog {
  return { date, bedtime, wakeTime, updatedAt: `${date}T07:00:00.000Z` };
}

const TODAY = "2026-06-21";

describe("buildRecentDays — recent N days digest (excludes today)", () => {
  it("summarises meals/workouts/sleep for prior days, newest-first", () => {
    const meals = [
      meal(TODAY, 999), // today — must be EXCLUDED
      meal("2026-06-20", 500),
      meal("2026-06-20", 700), // 2 meals, 1200 kcal
      meal("2026-06-19", 600),
    ];
    const workouts: Record<string, Workout> = {
      "2026-06-20": {
        date: "2026-06-20",
        exercises: [{ id: "e1", name: "ベンチプレス", sets: 3, reps: 10, weight: 60 }],
        updatedAt: "2026-06-20T20:00:00.000Z",
      },
    };
    const sleepStore: Record<string, SleepLog> = {
      "2026-06-19": sleep("2026-06-19", "23:00", "07:00"),
    };

    const days = buildRecentDays({
      todayKey: TODAY,
      meals,
      workouts,
      sleep: sleepStore,
      weightKg: 70,
      days: 7,
    });

    // Newest-first: 6/20 then 6/19. Today excluded.
    expect(days.length).toBe(2);
    expect(days[0].label).toContain("6月20日");
    expect(days[0].intakeKcal).toBe(1200);
    expect(days[0].mealCount).toBe(2);
    expect(days[0].exerciseCount).toBe(1);
    expect(days[0].burnKcal).toBeGreaterThan(0); // weightKg present → burn computed
    expect(days[1].label).toContain("6月19日");
    expect(days[1].intakeKcal).toBe(600);
    expect(days[1].sleep).toBe("8時間0分"); // length only, compact
  });

  it("skips days with nothing logged (no padding)", () => {
    const days = buildRecentDays({
      todayKey: TODAY,
      meals: [meal("2026-06-18", 400)],
      workouts: {},
      sleep: {},
      weightKg: 70,
    });
    // Only 6/18 has data → exactly one entry (6/20, 6/19, etc. are empty → skipped).
    expect(days.length).toBe(1);
    expect(days[0].label).toContain("6月18日");
  });

  it("omits burn when weight is unknown (never fabricated)", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-20": {
        date: "2026-06-20",
        exercises: [{ id: "e1", name: "腕立て伏せ", sets: 3, reps: 20, weight: 0 }],
        updatedAt: "2026-06-20T20:00:00.000Z",
      },
    };
    const days = buildRecentDays({
      todayKey: TODAY,
      meals: [],
      workouts,
      sleep: {},
      weightKg: null,
    });
    expect(days.length).toBe(1);
    expect(days[0].exerciseCount).toBe(1);
    expect(days[0].burnKcal).toBeUndefined(); // no weight → no burn figure
    expect(days[0].workouts?.join(" ")).toContain("腕立て伏せ");
  });

  it("attaches per-meal item detail across the whole recent window (grounds 「昨日と同じ」)", () => {
    const withItems = (date: string): Meal => ({
      id: `${date}-items`,
      date,
      timestamp: `${date}T18:00:00.000Z`,
      type: "夕",
      text: "",
      nutrition: {
        calories: 336,
        items: [
          { id: "i1", name: "角ハイボール", grams: 350, qty: 1, kcal: 336, proteinG: 0, fatG: 0, carbG: 8, sourceKind: "estimate" },
        ],
      },
    });
    const days = buildRecentDays({
      todayKey: TODAY,
      meals: [withItems("2026-06-20"), withItems("2026-06-16")], // 昨日(i=1) と 5日前(i=5)
      workouts: {},
      sleep: {},
      weightKg: null,
    });
    const yesterday = days.find((d) => d.label.includes("6月20"));
    const older = days.find((d) => d.label.includes("6月16"));
    // 昨日は品目を持つ＝コーチが同じ内容で記録できる
    expect(yesterday?.meals?.[0]?.items?.some((s) => s.includes("角ハイボール"))).toBe(true);
    expect(yesterday?.meals?.[0]?.type).toBe("夕");
    // 直近7日内なら5日前も実品目を持つ＝コーチが「一昨日/先週の中身は見えない」と言わない。
    expect(older?.intakeKcal).toBe(336);
    expect(older?.meals?.[0]?.items?.some((s) => s.includes("角ハイボール"))).toBe(true);
  });

  it("counts only eaten meals in the recent meal count and detail", () => {
    const eaten: Meal = {
      id: "eaten",
      date: "2026-06-20",
      timestamp: "2026-06-20T12:00:00.000Z",
      type: "昼",
      text: "",
      nutrition: {
        calories: 500,
        items: [
          { id: "i1", name: "鶏むね肉", grams: 100, qty: 1, kcal: 108, proteinG: 22, fatG: 2, carbG: 0, sourceKind: "db" },
        ],
      },
    };
    const planned: Meal = {
      id: "planned",
      date: "2026-06-20",
      timestamp: "2026-06-20T18:00:00.000Z",
      type: "夕",
      text: "",
      status: "planned",
      nutrition: {
        calories: 999,
        items: [
          { id: "i2", name: "予定のカレー", grams: 300, qty: 1, kcal: 999, proteinG: 20, fatG: 30, carbG: 120, sourceKind: "estimate" },
        ],
      },
    };

    const days = buildRecentDays({
      todayKey: TODAY,
      meals: [eaten, planned],
      workouts: {},
      sleep: {},
      weightKg: null,
    });

    expect(days[0].intakeKcal).toBe(500);
    expect(days[0].mealCount).toBe(1);
    expect(days[0].meals?.[0]?.items).toEqual(["鶏むね肉100g"]);
    expect(days[0].meals?.[0]?.items.join(" ")).not.toContain("予定のカレー");
  });

  it("attaches workout item detail and full sleep detail for recent days", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-20": {
        date: "2026-06-20",
        exercises: [
          { id: "e1", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
          { id: "e2", name: "明日の予定", sets: 2, reps: 12, weight: 0, status: "planned" },
        ],
        updatedAt: "2026-06-20T20:00:00.000Z",
      },
    };
    const days = buildRecentDays({
      todayKey: TODAY,
      meals: [],
      workouts,
      sleep: { "2026-06-20": sleep("2026-06-20", "23:30", "07:10") },
      weightKg: 70,
      days: 7,
    });
    const yesterday = days.find((d) => d.label.includes("6月20"));

    expect(yesterday?.exerciseCount).toBe(1);
    expect(yesterday?.workouts?.some((s) => s.includes("ブルガリアンスクワット"))).toBe(true);
    expect(yesterday?.workouts?.join(" ")).not.toContain("明日の予定");
    expect(yesterday?.sleep).toBe("7時間40分");
    expect(yesterday?.sleepDetail).toBe("23:30→07:10（7時間40分）");
  });
});

describe("todaySleepSummary", () => {
  it("returns today's sleep line or undefined", () => {
    const store = { [TODAY]: sleep(TODAY, "00:00", "06:00") };
    expect(todaySleepSummary(store, TODAY)).toBe("00:00→06:00（6時間0分）");
    expect(todaySleepSummary({}, TODAY)).toBeUndefined();
  });
});

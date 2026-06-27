import { describe, it, expect } from "vitest";
import {
  buildNutritionWindows,
  buildSleepWindows,
  buildMuscleGroups,
  buildProgression,
  buildWeightTrend,
  buildCoachHistory,
} from "./coachContext";
import { shiftDateKey } from "./date";
import type { Meal, NutritionTargets, SleepLog, Workout } from "./types";
import type { WeightEntry } from "./weightLog";

const TODAY = "2026-06-24";

/** A meal on `dateKey` carrying the given kcal + PFC (one item, db-ish). */
function meal(dateKey: string, kcal: number, p: number, f: number, c: number): Meal {
  return {
    id: `${dateKey}-${kcal}-${Math.random()}`,
    date: dateKey,
    timestamp: `${dateKey}T12:00:00.000Z`,
    type: "昼",
    text: "テスト食事",
    nutrition: { calories: kcal, proteinG: p, fatG: f, carbG: c },
  };
}

/** A workout doc for `dateKey` from a list of [name, weight, reps]. */
function workout(dateKey: string, exs: Array<[string, number, number]>): Workout {
  return {
    date: dateKey,
    updatedAt: `${dateKey}T18:00:00.000Z`,
    exercises: exs.map(([name, weight, reps], i) => ({
      id: `${dateKey}-${i}`,
      name,
      sets: 3,
      reps,
      weight,
    })),
  };
}

function sleepLog(dateKey: string, bedtime: string, wakeTime: string): SleepLog {
  return {
    date: dateKey,
    bedtime,
    wakeTime,
    updatedAt: `${dateKey}T07:00:00.000Z`,
  };
}

const TARGETS: NutritionTargets = {
  bmr: 1500,
  tdee: 2300,
  calories: 2000,
  proteinG: 150,
  fatG: 60,
  carbG: 200,
  bmrMethod: "Mifflin-St Jeor",
};

describe("buildNutritionWindows", () => {
  it("averages over LOGGED days only (a quiet day is not a 0-kcal day)", () => {
    // 3 logged days in the last 7: 1500/1800/2100 kcal, P 100 each.
    const meals = [
      meal(shiftDateKey(TODAY, 0), 1500, 100, 50, 150),
      meal(shiftDateKey(TODAY, -1), 1800, 100, 50, 150),
      meal(shiftDateKey(TODAY, -2), 2100, 100, 50, 150),
    ];
    const windows = buildNutritionWindows({ todayKey: TODAY, meals, targets: TARGETS });
    const w7 = windows.find((w) => w.days === 7)!;
    expect(w7.loggedDays).toBe(3);
    expect(w7.avgKcal).toBe(1800); // (1500+1800+2100)/3
    expect(w7.avgProteinG).toBe(100);
    // protein target 150 − avg 100 = 50/day shortfall.
    expect(w7.proteinDeficitG).toBe(50);
    // avg kcal 1800 vs target 2000 = −200/day.
    expect(w7.kcalVsTarget).toBe(-200);
  });

  it("omits averages for a window with no logged days", () => {
    const windows = buildNutritionWindows({ todayKey: TODAY, meals: [], targets: TARGETS });
    for (const w of windows) {
      expect(w.loggedDays).toBe(0);
      expect(w.avgKcal).toBeUndefined();
      expect(w.proteinDeficitG).toBeUndefined();
    }
  });

  it("protein deficit is 0 (not negative) when at/above target", () => {
    const meals = [meal(TODAY, 2000, 200, 60, 200)];
    const w = buildNutritionWindows({ todayKey: TODAY, meals, targets: TARGETS }).find(
      (x) => x.days === 7,
    )!;
    expect(w.proteinDeficitG).toBe(0);
  });

  it("only the within-window days count (a 10-day-old meal is excluded from the 7d window)", () => {
    const meals = [
      meal(TODAY, 2000, 150, 60, 200),
      meal(shiftDateKey(TODAY, -10), 9999, 999, 999, 999), // outside 7d
    ];
    const w7 = buildNutritionWindows({ todayKey: TODAY, meals, targets: TARGETS }).find(
      (x) => x.days === 7,
    )!;
    expect(w7.loggedDays).toBe(1);
    expect(w7.avgKcal).toBe(2000);
    // 14d window also excludes the 10-day-old? No — it's within 14, but the 7d must not.
    const w14 = buildNutritionWindows({ todayKey: TODAY, meals, targets: TARGETS }).find(
      (x) => x.days === 14,
    )!;
    expect(w14.loggedDays).toBe(2);
  });

  it("keeps annual nutrition signal while shorter windows stay bounded", () => {
    const meals = [
      meal(TODAY, 2000, 150, 60, 200),
      meal(shiftDateKey(TODAY, -200), 1200, 60, 30, 150),
    ];
    const windows = buildNutritionWindows({ todayKey: TODAY, meals, targets: TARGETS });
    expect(windows.map((w) => w.days)).toEqual([7, 14, 30, 90, 365]);
    expect(windows.find((w) => w.days === 90)?.loggedDays).toBe(1);
    expect(windows.find((w) => w.days === 365)?.loggedDays).toBe(2);
  });
});

describe("buildSleepWindows", () => {
  it("averages sleep over 7/30/90/365 days and flags short nights", () => {
    const sleep: Record<string, SleepLog> = {
      [TODAY]: sleepLog(TODAY, "23:00", "07:00"), // 8h
      [shiftDateKey(TODAY, -20)]: sleepLog(shiftDateKey(TODAY, -20), "01:00", "06:00"), // 5h
      [shiftDateKey(TODAY, -200)]: sleepLog(shiftDateKey(TODAY, -200), "22:00", "07:00"), // 9h
    };
    const windows = buildSleepWindows({ todayKey: TODAY, sleep });
    expect(windows.map((w) => w.days)).toEqual([7, 30, 90, 365]);
    expect(windows.find((w) => w.days === 7)?.loggedDays).toBe(1);
    expect(windows.find((w) => w.days === 30)?.loggedDays).toBe(2);
    expect(windows.find((w) => w.days === 30)?.shortSleepDays).toBe(1);
    expect(windows.find((w) => w.days === 365)?.loggedDays).toBe(3);
  });
});

describe("buildMuscleGroups", () => {
  it("counts trained days per group and lists untrained MAIN groups (空白)", () => {
    const workouts: Record<string, Workout> = {
      [shiftDateKey(TODAY, 0)]: workout(shiftDateKey(TODAY, 0), [["ベンチプレス", 60, 10]]),
      [shiftDateKey(TODAY, -2)]: workout(shiftDateKey(TODAY, -2), [["懸垂", 0, 8]]),
    };
    const r = buildMuscleGroups({ todayKey: TODAY, workouts });
    expect(r.workoutDaysInWindow).toBe(2);
    const chest = r.muscleGroups.find((m) => m.group === "chest")!;
    expect(chest.daysTrained).toBe(1);
    expect(chest.daysSinceLast).toBe(0); // today
    const back = r.muscleGroups.find((m) => m.group === "back")!;
    expect(back.daysTrained).toBe(1);
    expect(back.daysSinceLast).toBe(2);
    // legs/shoulders/arms/core never trained → in the untrained list.
    expect(r.untrainedGroups).toContain("legs");
    expect(r.untrainedGroups).toContain("shoulders");
    expect(r.untrainedGroups).toContain("arms");
    expect(r.untrainedGroups).toContain("core");
    // chest/back are NOT untrained.
    expect(r.untrainedGroups).not.toContain("chest");
    expect(r.untrainedGroups).not.toContain("back");
  });

  it("cardio does not count as a strength gap (not in untrainedGroups)", () => {
    const workouts: Record<string, Workout> = {
      [TODAY]: workout(TODAY, [["ランニング", 0, 0]]),
    };
    const r = buildMuscleGroups({ todayKey: TODAY, workouts });
    expect(r.untrainedGroups).not.toContain("cardio");
    // all 6 main groups untrained (only cardio was done).
    expect(r.untrainedGroups.length).toBe(6);
  });
});

describe("buildProgression", () => {
  it("labels a weighted lift that gains volume as 'up'", () => {
    const workouts: Record<string, Workout> = {
      [shiftDateKey(TODAY, -10)]: workout(shiftDateKey(TODAY, -10), [["ベンチプレス", 50, 10]]),
      [shiftDateKey(TODAY, 0)]: workout(shiftDateKey(TODAY, 0), [["ベンチプレス", 70, 10]]),
    };
    const prog = buildProgression({ todayKey: TODAY, workouts });
    const bench = prog.find((p) => p.name === "ベンチプレス")!;
    expect(bench.sessions).toBe(2);
    expect(bench.trend).toBe("up");
    // sets:3 (legacy) → recent 3×70×10=2100, first 3×50×10=1500 (legacy-set expansion).
    expect(bench.recentVolumeKg).toBe(2100);
    expect(bench.firstVolumeKg).toBe(1500);
    expect(bench.topWeightKg).toBe(70);
  });

  it("labels a stable lift as 'flat' and a single-session lift as 'insufficient'", () => {
    const workouts: Record<string, Workout> = {
      [shiftDateKey(TODAY, -5)]: workout(shiftDateKey(TODAY, -5), [["スクワット", 80, 10]]),
      [shiftDateKey(TODAY, 0)]: workout(shiftDateKey(TODAY, 0), [
        ["スクワット", 80, 10],
        ["デッドリフト", 100, 5], // single session
      ]),
    };
    const prog = buildProgression({ todayKey: TODAY, workouts });
    expect(prog.find((p) => p.name === "スクワット")!.trend).toBe("flat");
    expect(prog.find((p) => p.name === "デッドリフト")!.trend).toBe("insufficient");
  });

  it("excludes bodyweight moves (no 総挙上量 metric)", () => {
    const workouts: Record<string, Workout> = {
      [TODAY]: workout(TODAY, [["腕立て伏せ", 0, 20]]),
    };
    const prog = buildProgression({ todayKey: TODAY, workouts });
    expect(prog.length).toBe(0);
  });

  it("counts ALL sets of a LEGACY record (sets×reps×weight), not just one (Codex fix)", () => {
    // Legacy record: NO setEntries — 3 sets × 10 reps × 60kg = 1800kg, not 600.
    const legacy: Workout = {
      date: TODAY,
      updatedAt: `${TODAY}T18:00:00.000Z`,
      exercises: [{ id: "x", name: "ベンチプレス", sets: 3, reps: 10, weight: 60 }],
    };
    const prog = buildProgression({ todayKey: TODAY, workouts: { [TODAY]: legacy } });
    expect(prog[0].recentVolumeKg).toBe(1800);
    expect(prog[0].topWeightKg).toBe(60);
  });

  it("tracks progression across the annual window, not only the latest month", () => {
    const workouts: Record<string, Workout> = {
      [shiftDateKey(TODAY, -200)]: workout(shiftDateKey(TODAY, -200), [["ベンチプレス", 40, 10]]),
      [TODAY]: workout(TODAY, [["ベンチプレス", 70, 10]]),
    };
    const bench = buildProgression({ todayKey: TODAY, workouts }).find(
      (p) => p.name === "ベンチプレス",
    )!;
    expect(bench.sessions).toBe(2);
    expect(bench.trend).toBe("up");
    expect(bench.firstVolumeKg).toBe(1200);
    expect(bench.recentVolumeKg).toBe(2100);
  });
});

describe("buildWeightTrend", () => {
  it("returns start→latest delta over the window", () => {
    const weights: WeightEntry[] = [
      { date: shiftDateKey(TODAY, -20), weightKg: 72 },
      { date: shiftDateKey(TODAY, -10), weightKg: 71 },
      { date: TODAY, weightKg: 70 },
    ];
    const t = buildWeightTrend({ todayKey: TODAY, weights })!;
    expect(t.startKg).toBe(72);
    expect(t.latestKg).toBe(70);
    expect(t.deltaKg).toBe(-2);
    expect(t.spanDays).toBe(20);
  });

  it("needs ≥2 weigh-ins (a single point isn't a trend)", () => {
    const weights: WeightEntry[] = [{ date: TODAY, weightKg: 70 }];
    expect(buildWeightTrend({ todayKey: TODAY, weights })).toBeUndefined();
  });
});

describe("buildCoachHistory — assembly", () => {
  it("a brand-new (empty) history yields a mostly-empty summary (nothing invented)", () => {
    const h = buildCoachHistory({
      todayKey: TODAY,
      meals: [],
      workouts: {},
      sleep: {},
      weights: [],
      profile: null,
      targets: null,
    });
    expect(h.nutrition).toBeUndefined(); // no logged days in any window
    expect(h.sleep).toBeUndefined();
    expect(h.muscleGroups).toBeUndefined();
    expect(h.longTermMuscleGroups).toBeUndefined();
    expect(h.progression).toBeUndefined();
    expect(h.weightTrend).toBeUndefined();
  });

  it("attaches each block only when it has real signal, including annual history", () => {
    const h = buildCoachHistory({
      todayKey: TODAY,
      meals: [meal(TODAY, 1800, 100, 50, 150)],
      workouts: {
        [TODAY]: workout(TODAY, [["ベンチプレス", 60, 10]]),
        [shiftDateKey(TODAY, -200)]: workout(shiftDateKey(TODAY, -200), [["スクワット", 80, 10]]),
      },
      sleep: { [TODAY]: sleepLog(TODAY, "23:00", "07:00") },
      weights: [
        { date: shiftDateKey(TODAY, -200), weightKg: 75 },
        { date: TODAY, weightKg: 70 },
      ],
      profile: null,
      targets: TARGETS,
    });
    expect(h.nutrition).toBeDefined();
    expect(h.sleep).toBeDefined();
    expect(h.muscleGroups).toBeDefined();
    expect(h.workoutDaysInWindow).toBe(1);
    expect(h.longTermWorkoutDays).toBe(2);
    expect(h.longTermMuscleGroups?.find((g) => g.group === "legs")?.daysTrained).toBe(1);
    expect(h.untrainedGroups).toContain("legs");
    expect(h.weightTrend).toBeDefined();
    expect(h.weightTrend?.spanDays).toBe(200);
    // single bench session → progression present but insufficient trend.
    expect(h.progression?.find((p) => p.name === "ベンチプレス")?.trend).toBe("insufficient");
  });
});

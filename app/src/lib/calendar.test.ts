import { describe, it, expect } from "vitest";
import {
  monthOf,
  shiftMonth,
  formatMonthLabel,
  buildMonthGrid,
  classifyNutrient,
  classifyDayNutrition,
  VERDICT_LABEL,
  DEFAULT_TOLERANCE,
  type DayIntake,
} from "./calendar";

// ---- Month grid ------------------------------------------------------------

describe("monthOf / shiftMonth / formatMonthLabel", () => {
  it("derives the month a date-key belongs to", () => {
    expect(monthOf("2026-06-17")).toEqual({ year: 2026, month: 6 });
    expect(monthOf("2026-01-01")).toEqual({ year: 2026, month: 1 });
    expect(monthOf("2026-12-31")).toEqual({ year: 2026, month: 12 });
  });

  it("rolls the year over forward across December", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });

  it("rolls the year over backward across January", () => {
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("steps multiple months", () => {
    expect(shiftMonth({ year: 2026, month: 6 }, 8)).toEqual({ year: 2027, month: 2 });
    expect(shiftMonth({ year: 2026, month: 6 }, -8)).toEqual({ year: 2025, month: 10 });
  });

  it("formats a Japanese month label", () => {
    expect(formatMonthLabel({ year: 2026, month: 6 })).toBe("2026年6月");
  });
});

describe("buildMonthGrid", () => {
  it("always returns a fixed 6×7 (42-cell) grid", () => {
    expect(buildMonthGrid({ year: 2026, month: 2 }, "2026-02-15")).toHaveLength(42);
    expect(buildMonthGrid({ year: 2026, month: 1 }, "2026-01-15")).toHaveLength(42);
    expect(buildMonthGrid({ year: 2026, month: 8 }, "2026-08-15")).toHaveLength(42);
  });

  it("starts on the Sunday on/before the 1st (Sunday-first)", () => {
    // 2026-06-01 is a Monday → grid starts the day before, Sunday 2026-05-31.
    const grid = buildMonthGrid({ year: 2026, month: 6 }, "2026-06-17");
    expect(grid[0].key).toBe("2026-05-31");
    expect(grid[0].inMonth).toBe(false);
  });

  it("includes every in-month day with the right inMonth flag", () => {
    const grid = buildMonthGrid({ year: 2026, month: 6 }, "2026-06-17");
    const inMonth = grid.filter((c) => c.inMonth);
    // June has 30 days.
    expect(inMonth).toHaveLength(30);
    expect(inMonth[0].key).toBe("2026-06-01");
    expect(inMonth[29].key).toBe("2026-06-30");
  });

  it("flags today and future days correctly", () => {
    const grid = buildMonthGrid({ year: 2026, month: 6 }, "2026-06-17");
    const today = grid.find((c) => c.key === "2026-06-17");
    const past = grid.find((c) => c.key === "2026-06-10");
    const future = grid.find((c) => c.key === "2026-06-25");
    expect(today?.isToday).toBe(true);
    expect(today?.isFuture).toBe(false);
    expect(past?.isFuture).toBe(false);
    expect(future?.isFuture).toBe(true);
  });

  it("handles a leap-year February (29 in-month days)", () => {
    // 2028 is a leap year.
    const grid = buildMonthGrid({ year: 2028, month: 2 }, "2028-02-15");
    const inMonth = grid.filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(29);
    expect(inMonth[28].key).toBe("2028-02-29");
  });

  it("handles a December→January year boundary in the trailing cells", () => {
    const grid = buildMonthGrid({ year: 2026, month: 12 }, "2026-12-15");
    const inMonth = grid.filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[30].key).toBe("2026-12-31");
    // Trailing cells should spill into 2027-01.
    const trailing = grid.filter((c) => !c.inMonth && c.key > "2026-12-31");
    expect(trailing.length).toBeGreaterThan(0);
    expect(trailing[0].key).toBe("2027-01-01");
  });

  it("keeps cell keys unique and chronologically ordered", () => {
    const grid = buildMonthGrid({ year: 2026, month: 6 }, "2026-06-17");
    const keys = grid.map((c) => c.key);
    expect(new Set(keys).size).toBe(42);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

// ---- Nutrient classification ----------------------------------------------

describe("classifyNutrient — tolerance band + boundaries", () => {
  it("labels a value within ±10% as 適正 (ok)", () => {
    // target 2000, band ±200.
    expect(classifyNutrient("kcal", "カロリー", "kcal", 2000, 2000).verdict).toBe("ok");
    expect(classifyNutrient("kcal", "カロリー", "kcal", 2100, 2000).verdict).toBe("ok");
    expect(classifyNutrient("kcal", "カロリー", "kcal", 1900, 2000).verdict).toBe("ok");
  });

  it("treats the exact band edges as 適正 (≤ tolerance, inclusive)", () => {
    // Exactly +10% and −10% → still ok (boundary is inclusive).
    expect(classifyNutrient("kcal", "カロリー", "kcal", 2200, 2000).verdict).toBe("ok");
    expect(classifyNutrient("kcal", "カロリー", "kcal", 1800, 2000).verdict).toBe("ok");
  });

  it("labels just outside the upper edge as 過剰 (surplus)", () => {
    expect(classifyNutrient("kcal", "カロリー", "kcal", 2201, 2000).verdict).toBe("surplus");
  });

  it("labels just outside the lower edge as 不足 (deficit)", () => {
    expect(classifyNutrient("kcal", "カロリー", "kcal", 1799, 2000).verdict).toBe("deficit");
  });

  it("reports the signed gap (actual − target)", () => {
    expect(classifyNutrient("protein", "P", "g", 90, 120).gap).toBe(-30);
    expect(classifyNutrient("protein", "P", "g", 150, 120).gap).toBe(30);
  });

  it("returns unknown (no verdict, no gap) when target is null", () => {
    const r = classifyNutrient("kcal", "カロリー", "kcal", 1500, null);
    expect(r.verdict).toBe("unknown");
    expect(r.target).toBeNull();
    expect(r.gap).toBeNull();
  });

  it("returns unknown for a zero or negative target (no divide-by-zero)", () => {
    expect(classifyNutrient("kcal", "カロリー", "kcal", 1500, 0).verdict).toBe("unknown");
    expect(classifyNutrient("kcal", "カロリー", "kcal", 1500, -10).verdict).toBe("unknown");
  });

  it("treats a non-finite actual as 0", () => {
    const r = classifyNutrient("kcal", "カロリー", "kcal", Number.NaN, 2000);
    expect(r.actual).toBe(0);
    expect(r.verdict).toBe("deficit");
  });

  it("respects a custom tolerance band", () => {
    // With a tight 1% band, +5% reads as 過剰.
    expect(classifyNutrient("kcal", "カロリー", "kcal", 2100, 2000, 0.01).verdict).toBe("surplus");
    // The default band is 10%.
    expect(DEFAULT_TOLERANCE).toBe(0.1);
  });

  it("rounds actual/target/gap to whole numbers for display", () => {
    const r = classifyNutrient("fat", "F", "g", 55.7, 50.2);
    expect(r.actual).toBe(56);
    expect(r.target).toBe(50);
    expect(Number.isInteger(r.gap)).toBe(true);
  });
});

describe("classifyDayNutrition — full-day kcal + PFC", () => {
  const intake: DayIntake = { calories: 2000, proteinG: 90, fatG: 60, carbG: 250 };
  const targets = { calories: 2000, proteinG: 120, fatG: 55, carbG: 250 };

  it("classifies all four macros against targets", () => {
    const out = classifyDayNutrition(intake, targets);
    expect(out.map((n) => n.key)).toEqual(["kcal", "protein", "fat", "carb"]);
    const byKey = Object.fromEntries(out.map((n) => [n.key, n.verdict]));
    expect(byKey.kcal).toBe("ok"); // exactly on target
    expect(byKey.protein).toBe("deficit"); // 90 vs 120 (−25%)
    expect(byKey.fat).toBe("ok"); // 60 vs 55 (+9%, within 10%)
    expect(byKey.carb).toBe("ok"); // exactly on target
  });

  it("returns all-unknown when no targets (no profile)", () => {
    const out = classifyDayNutrition(intake, null);
    expect(out.every((n) => n.verdict === "unknown")).toBe(true);
    expect(out.every((n) => n.target === null)).toBe(true);
  });

  it("only ever covers kcal + PFC (no micronutrient verdicts)", () => {
    const out = classifyDayNutrition(intake, targets);
    expect(out).toHaveLength(4);
    // No vitamin/mineral keys leak in.
    expect(out.some((n) => n.key === "kcal")).toBe(true);
    expect(out.every((n) => ["kcal", "protein", "fat", "carb"].includes(n.key))).toBe(true);
  });
});

describe("VERDICT_LABEL", () => {
  it("maps verdicts to the Japanese UI labels", () => {
    expect(VERDICT_LABEL.deficit).toBe("不足");
    expect(VERDICT_LABEL.ok).toBe("適正");
    expect(VERDICT_LABEL.surplus).toBe("過剰");
    expect(VERDICT_LABEL.unknown).toBe("—");
  });
});

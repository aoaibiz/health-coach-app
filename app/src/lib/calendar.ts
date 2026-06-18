// Pure logic for the calendar / day-history page.
//
// Two responsibilities, both DOM-free and unit-tested:
//   1. Month-grid math  — turn a month into a fixed 6-row × 7-col grid of local
//      calendar day-keys, plus prev/next month navigation. Mirrors date.ts's
//      local-calendar keying (toDateKey/fromDateKey) so a cell's key matches
//      EXACTLY how meals (m.date), workouts (record key) and weight (entry.date)
//      are stored — otherwise the calendar would mark the wrong day.
//   2. Nutrition surplus/deficit classification — compare a day's REAL intake
//      totals (kcal + P/F/C) against the user's REAL derived targets and label
//      each as 不足 / 適正 / 過剰 within a tolerance band.
//
// ┌─ ANTI-FABRICATION CONTRACT ───────────────────────────────────────────────┐
// │ Classification covers ONLY the macros the app tracks per meal: kcal + PFC. │
// │ Micronutrients (ビタミン/ミネラル) are NOT tracked per logged meal, so this │
// │ module never emits a verdict about them — the UI says so honestly.         │
// │ A verdict requires BOTH a target (profile set) AND that the day logged at   │
// │ least one meal with that nutrition value; otherwise it is "unknown", never  │
// │ a fabricated 不足/過剰. No division by an absent/zero target.               │
// └────────────────────────────────────────────────────────────────────────────┘

import { fromDateKey, toDateKey } from "./date";

// ---- Month grid ------------------------------------------------------------

/** A single calendar cell. `inMonth` is false for the leading/trailing days
 *  that pad the grid to whole weeks (shown dimmed). `isFuture` flags days after
 *  today (no data can exist yet — surfaced, never zero-filled). */
export interface CalendarCell {
  /** Local calendar day key, YYYY-MM-DD (matches date.ts toDateKey). */
  key: string;
  /** Day-of-month number (1–31). */
  day: number;
  /** True when the cell belongs to the grid's focused month. */
  inMonth: boolean;
  /** True when the cell is today's local date. */
  isToday: boolean;
  /** True when the cell is strictly after today. */
  isFuture: boolean;
}

/** A month identified by its year + 1-based month (1 = January). */
export interface MonthRef {
  year: number;
  /** 1–12. */
  month: number;
}

/** The MonthRef the given date-key belongs to (defaults to today). */
export function monthOf(dateKey: string = toDateKey()): MonthRef {
  const d = fromDateKey(dateKey);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/** Step a MonthRef by ±N months, rolling the year over correctly. */
export function shiftMonth(ref: MonthRef, delta: number): MonthRef {
  // Date math handles year rollover (e.g. Dec +1 → next Jan) without manual mod.
  const d = new Date(ref.year, ref.month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/** "2026年6月" — the focused month's heading. */
export function formatMonthLabel(ref: MonthRef): string {
  return `${ref.year}年${ref.month}月`;
}

/** Japanese weekday headers, Sunday-first (matches the grid's column order). */
export const WEEKDAY_HEADERS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/**
 * Build a Sunday-first month grid. Always 6 rows × 7 cols (42 cells) so the
 * grid height is stable across months (a 28-day Feb and a 31-day month look the
 * same). Leading days fill from the previous month, trailing from the next, both
 * flagged `inMonth: false`. Every cell carries a real local day-key, so a day's
 * data is found by exact key match — never by index arithmetic.
 *
 * `todayKey` is injected (defaults to the real today) so the pure function is
 * deterministic in tests; the UI passes the real today.
 */
export function buildMonthGrid(
  ref: MonthRef,
  todayKey: string = toDateKey(),
): CalendarCell[] {
  const first = new Date(ref.year, ref.month - 1, 1);
  // getDay(): 0=Sun … 6=Sat. Back up to the Sunday on/before the 1st.
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());

  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const key = toDateKey(d);
    cells.push({
      key,
      day: d.getDate(),
      inMonth: d.getMonth() === ref.month - 1 && d.getFullYear() === ref.year,
      isToday: key === todayKey,
      // String compare is valid because YYYY-MM-DD sorts chronologically.
      isFuture: key > todayKey,
    });
  }
  return cells;
}

// ---- Nutrient surplus / deficit classification -----------------------------

/** Where a logged value sits relative to its target. */
export type NutrientVerdict = "deficit" | "ok" | "surplus" | "unknown";

/** Japanese label for a verdict (UI). */
export const VERDICT_LABEL: Record<NutrientVerdict, string> = {
  deficit: "不足",
  ok: "適正",
  surplus: "過剰",
  unknown: "—",
};

/**
 * Default tolerance band: a logged value within ±10% of its target counts as
 * 適正. Below the band → 不足, above → 過剰. 10% is a deliberate, transparent
 * choice (a single missed snack shouldn't read as "過剰"); it's surfaced in the
 * UI so the band is never a hidden assumption. Configurable per call for tests.
 */
export const DEFAULT_TOLERANCE = 0.1;

/** One nutrient's comparison of a logged actual against its target. */
export interface NutrientComparison {
  /** kcal | P | F | C — the four tracked macros. */
  key: "kcal" | "protein" | "fat" | "carb";
  label: string;
  /** Unit suffix for display (kcal / g). */
  unit: "kcal" | "g";
  /** The day's real logged total for this nutrient. */
  actual: number;
  /** The user's derived target, or null when no profile/target exists. */
  target: number | null;
  verdict: NutrientVerdict;
  /** Signed gap actual − target (rounded), or null when target is unknown. */
  gap: number | null;
}

/**
 * Classify one nutrient. Pure, with explicit, honest edge handling:
 *   - target null/≤0 (no profile, or a degenerate target)  → "unknown", gap null
 *     (we never divide by zero, and we never invent a verdict without a target).
 *   - otherwise: |actual − target| ≤ tolerance×target → "ok"; below → "deficit";
 *     above → "surplus".
 * `actual` is taken as a real logged total (0 is a legitimate "logged nothing of
 * this nutrient" value once at least one nutrition entry exists — the caller
 * decides whether the day has any data at all before showing verdicts).
 */
export function classifyNutrient(
  key: NutrientComparison["key"],
  label: string,
  unit: NutrientComparison["unit"],
  actual: number,
  target: number | null,
  tolerance: number = DEFAULT_TOLERANCE,
): NutrientComparison {
  const safeActual = Number.isFinite(actual) ? actual : 0;
  if (target == null || !Number.isFinite(target) || target <= 0) {
    return { key, label, unit, actual: safeActual, target: null, verdict: "unknown", gap: null };
  }
  const band = target * tolerance;
  const diff = safeActual - target;
  let verdict: NutrientVerdict;
  if (Math.abs(diff) <= band) verdict = "ok";
  else if (diff < 0) verdict = "deficit";
  else verdict = "surplus";
  return {
    key,
    label,
    unit,
    actual: Math.round(safeActual),
    target: Math.round(target),
    verdict,
    gap: Math.round(diff),
  };
}

/** The real intake totals a day logged (kcal + PFC). Mirrors IntakeTotals. */
export interface DayIntake {
  calories: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

/** The derived targets to compare against (subset of NutritionTargets). */
export interface DayTargets {
  calories: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

/**
 * Classify all four tracked macros for a day. When `targets` is null (no
 * profile yet), every nutrient comes back "unknown" — the UI then tells the user
 * to set up a profile rather than showing fabricated 不足/過剰 verdicts.
 *
 * IMPORTANT (anti-fabrication): this covers kcal + PFC only — the nutrients the
 * app actually tracks per meal. It deliberately emits NO micronutrient verdicts.
 */
export function classifyDayNutrition(
  intake: DayIntake,
  targets: DayTargets | null,
  tolerance: number = DEFAULT_TOLERANCE,
): NutrientComparison[] {
  return [
    classifyNutrient("kcal", "カロリー", "kcal", intake.calories, targets?.calories ?? null, tolerance),
    classifyNutrient("protein", "たんぱく質", "g", intake.proteinG, targets?.proteinG ?? null, tolerance),
    classifyNutrient("fat", "脂質", "g", intake.fatG, targets?.fatG ?? null, tolerance),
    classifyNutrient("carb", "炭水化物", "g", intake.carbG, targets?.carbG ?? null, tolerance),
  ];
}

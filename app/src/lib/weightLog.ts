// localStorage persistence for the daily weight log (Phase: weight tracking).
// Mirrors storage.ts / chatStore.ts: SSR-safe read/write (no window → no-op),
// with the shaping/calc helpers kept fully pure so they're unit-testable with
// no DOM. Entries are keyed by local calendar day (see date.ts) — one per day,
// re-entering a day updates it.

import { toDateKey } from "./date";
import { clearTombstones } from "./deletionsStore";
import { pushSectionBestEffort } from "./syncData";

/** A single day's recorded body weight. */
export interface WeightEntry {
  /** Local calendar day, YYYY-MM-DD (see date.ts toDateKey). */
  date: string;
  /** Body weight in kilograms. */
  weightKg: number;
}

export const WEIGHT_LOG_STORAGE_KEY = "health-app:weightLog:v1";

/** Cap stored history so localStorage never grows unbounded (years of daily). */
const MAX_STORED = 2000;

function isWeightEntry(v: unknown): v is WeightEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(e.date) &&
    typeof e.weightKg === "number" &&
    Number.isFinite(e.weightKg) &&
    e.weightKg > 0
  );
}

/**
 * Validate/filter a raw parsed value into a clean, date-sorted WeightEntry[].
 * Pure. Drops malformed rows; if a day somehow appears twice, the LAST one wins
 * (matches upsert semantics). Sorted ascending by date.
 */
export function sanitizeEntries(raw: unknown): WeightEntry[] {
  if (!Array.isArray(raw)) return [];
  const byDate = new Map<string, WeightEntry>();
  for (const v of raw) {
    if (isWeightEntry(v)) byDate.set(v.date, { date: v.date, weightKg: v.weightKg });
  }
  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-MAX_STORED);
}

/**
 * Upsert a day's weight into the log (pure). One entry per day: re-entering an
 * existing day replaces it. Returns a new, date-sorted array (does not mutate).
 */
export function upsertEntry(
  entries: WeightEntry[],
  date: string,
  weightKg: number,
): WeightEntry[] {
  const next = entries.filter((e) => e.date !== date);
  next.push({ date, weightKg });
  return next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The most recent (latest-dated) entry, or null when the log is empty. Pure. */
export function latestEntry(entries: WeightEntry[]): WeightEntry | null {
  if (entries.length === 0) return null;
  // sanitize/upsert keep it sorted ascending, so the last is the latest.
  return entries[entries.length - 1];
}

/**
 * 目標まであと何kg — signed difference current − target (pure).
 *   delta > 0  → above target, need to LOSE  (kg to go down)
 *   delta < 0  → below target, need to GAIN  (kg to go up)
 *   delta === 0 → reached.
 * Rounded to 1 decimal. Returns null when either input is missing.
 */
export interface RemainingToTarget {
  /** current − target, rounded to 1 decimal. */
  delta: number;
  /** Absolute kg remaining, rounded to 1 decimal. */
  abs: number;
  direction: "lose" | "gain" | "reached";
}

export function remainingToTarget(
  currentKg: number | null | undefined,
  targetKg: number | null | undefined,
): RemainingToTarget | null {
  if (currentKg == null || targetKg == null) return null;
  if (!Number.isFinite(currentKg) || !Number.isFinite(targetKg)) return null;
  const delta = Math.round((currentKg - targetKg) * 10) / 10;
  const abs = Math.abs(delta);
  const direction: RemainingToTarget["direction"] =
    delta > 0 ? "lose" : delta < 0 ? "gain" : "reached";
  return { delta, abs, direction };
}

// ---- Chart point mapping (pure, testable) ----------------------------------

export interface ChartPoint {
  /** x in the chart's coordinate space (px). */
  x: number;
  /** y in the chart's coordinate space (px). */
  y: number;
  entry: WeightEntry;
}

export interface ChartGeometry {
  points: ChartPoint[];
  /** y for the horizontal 目標 line, or null when no target. */
  targetY: number | null;
  /** Min/max weight the y-axis spans (after padding), for axis labels. */
  minKg: number;
  maxKg: number;
}

export interface ChartLayout {
  width: number;
  height: number;
  /** Inner padding (px) so the line/dots don't touch the edges. */
  padX: number;
  padY: number;
}

/**
 * Body weight moves in small steps; auto-zooming to a tiny data range makes a
 * 2kg gap look like a cliff. Enforce a sensible minimum visible y-span (centered)
 * so small differences read proportionally (e.g. 2kg over a ~10kg axis ≈ 20%).
 * Shared by both the line and bar geometry so their axes stay consistent.
 */
const MIN_SPAN_KG = 10;

/**
 * Map weight entries (and an optional target) into SVG coordinates. Pure so the
 * 0/1/many-point behaviour is unit-testable without rendering.
 *
 * Y-axis spans the data range (entries + target) with a little headroom, so the
 * target line always fits on-screen. Handles edge cases gracefully:
 *   - 0 points → empty points[], target still mapped (if any).
 *   - 1 point  → a single centered dot (no zero-width range blow-up).
 *   - flat data (all equal) → centered with a symmetric padded range.
 */
export function buildChartGeometry(
  entries: WeightEntry[],
  targetKg: number | null | undefined,
  layout: ChartLayout,
): ChartGeometry {
  const { width, height, padX, padY } = layout;
  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, height - padY * 2);

  const weights = entries.map((e) => e.weightKg);
  const target = targetKg != null && Number.isFinite(targetKg) ? targetKg : null;
  const domainVals = [...weights, ...(target != null ? [target] : [])];

  // Y domain: pad so the line/target don't sit on the frame. Symmetric ±0.5kg
  // fallback when all values are equal (or only one value).
  let minKg: number;
  let maxKg: number;
  if (domainVals.length === 0) {
    minKg = 0;
    maxKg = 1;
  } else {
    const lo = Math.min(...domainVals);
    const hi = Math.max(...domainVals);
    if (lo === hi) {
      minKg = lo - 0.5;
      maxKg = hi + 0.5;
    } else {
      const pad = (hi - lo) * 0.15;
      minKg = lo - pad;
      maxKg = hi + pad;
    }
  }
  // Body weight moves in small steps; auto-zooming to a tiny data range makes a
  // 2kg gap look like a cliff. Enforce a sensible minimum visible span (centered)
  // so small differences read proportionally (e.g. 2kg over a ~10kg axis ≈ 20%).
  if (maxKg - minKg < MIN_SPAN_KG) {
    const mid = (minKg + maxKg) / 2;
    minKg = mid - MIN_SPAN_KG / 2;
    maxKg = mid + MIN_SPAN_KG / 2;
  }
  const span = maxKg - minKg || 1;

  const yFor = (kg: number) =>
    // higher weight = higher on screen (smaller y).
    padY + innerH * (1 - (kg - minKg) / span);

  const n = entries.length;
  const xFor = (i: number) =>
    // single point sits centered; multiple spread across the inner width.
    n <= 1 ? padX + innerW / 2 : padX + (innerW * i) / (n - 1);

  const points: ChartPoint[] = entries.map((entry, i) => ({
    x: xFor(i),
    y: yFor(entry.weightKg),
    entry,
  }));

  return {
    points,
    targetY: target != null ? yFor(target) : null,
    minKg,
    maxKg,
  };
}

/** Build an SVG polyline `points` string from chart points. Pure. */
export function toPolylinePoints(points: ChartPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

// ---- Bar-chart geometry (pure, testable) -----------------------------------

/** One rendered bar: x/width position the bar, y/height its top + extent. */
export interface ChartBar {
  /** Left edge of the bar (px, in the chart's coordinate space). */
  x: number;
  /** Bar width (px). */
  width: number;
  /** Top edge of the bar (px) — maps to the entry's weight. */
  y: number;
  /** Bar height (px), from its top down to the baseline. Always ≥ 0. */
  height: number;
  /** Horizontal center of the bar (px) — handy for labels/ticks. */
  cx: number;
  entry: WeightEntry;
}

export interface BarChartGeometry {
  bars: ChartBar[];
  /** y for the horizontal 目標 line, or null when no target. */
  targetY: number | null;
  /** Baseline y (bottom of the bars). */
  baselineY: number;
  /** Min/max weight the y-axis spans (after padding), for axis labels. */
  minKg: number;
  maxKg: number;
}

export interface BarChartLayout extends ChartLayout {
  /** Fraction (0–1) of each slot the bar fills; the rest is the gap. */
  barRatio?: number;
  /** Max bar width (px) so a single/few bars don't become absurdly wide. */
  maxBarWidth?: number;
}

/**
 * Map weight entries (and an optional target) into rounded-bar SVG geometry.
 * Pure, so the 0/1/many-bar behaviour is unit-testable without rendering.
 *
 * Layout intent (matches the line version's domain math so axis labels agree):
 *   - The y-domain spans the data range plus the target, padded so the target
 *     line and the tallest bar never sit on the frame. Flat / single values get
 *     a symmetric ±0.5kg band.
 *   - Bars hang from each entry's weight DOWN to the baseline (bottom). Higher
 *     weight ⇒ smaller `y` (taller bar), so the chart reads as "weight height".
 *   - 0 entries → no bars (caller shows the empty prompt). 1 entry → a single
 *     centered, sensibly-capped bar (never a lonely dot). 2–3 → evenly spaced.
 */
export function buildBarGeometry(
  entries: WeightEntry[],
  targetKg: number | null | undefined,
  layout: BarChartLayout,
): BarChartGeometry {
  const { width, height, padX, padY } = layout;
  const barRatio = layout.barRatio ?? 0.62;
  const maxBarWidth = layout.maxBarWidth ?? 44;

  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, height - padY * 2);
  const baselineY = padY + innerH;

  const weights = entries.map((e) => e.weightKg);
  const target = targetKg != null && Number.isFinite(targetKg) ? targetKg : null;
  const domainVals = [...weights, ...(target != null ? [target] : [])];

  // Same y-domain rule as buildChartGeometry so the two stay consistent.
  let minKg: number;
  let maxKg: number;
  if (domainVals.length === 0) {
    minKg = 0;
    maxKg = 1;
  } else {
    const lo = Math.min(...domainVals);
    const hi = Math.max(...domainVals);
    if (lo === hi) {
      minKg = lo - 0.5;
      maxKg = hi + 0.5;
    } else {
      const pad = (hi - lo) * 0.15;
      minKg = lo - pad;
      maxKg = hi + pad;
    }
  }
  // Body weight moves in small steps; auto-zooming to a tiny data range makes a
  // 2kg gap look like a cliff. Enforce a sensible minimum visible span (centered)
  // so small differences read proportionally (e.g. 2kg over a ~10kg axis ≈ 20%).
  if (maxKg - minKg < MIN_SPAN_KG) {
    const mid = (minKg + maxKg) / 2;
    minKg = mid - MIN_SPAN_KG / 2;
    maxKg = mid + MIN_SPAN_KG / 2;
  }
  const span = maxKg - minKg || 1;

  const yFor = (kg: number) => padY + innerH * (1 - (kg - minKg) / span);

  const n = entries.length;
  // Evenly divide the inner width into n slots; bar fills `barRatio` of a slot,
  // capped by maxBarWidth so 1–2 bars look intentional rather than bloated.
  const slot = n > 0 ? innerW / n : innerW;
  const barWidth = n > 0 ? Math.min(slot * barRatio, maxBarWidth) : 0;

  const bars: ChartBar[] = entries.map((entry, i) => {
    const cx = padX + slot * (i + 0.5);
    const top = yFor(entry.weightKg);
    return {
      x: cx - barWidth / 2,
      width: barWidth,
      y: top,
      height: Math.max(0, baselineY - top),
      cx,
      entry,
    };
  });

  return {
    bars,
    targetY: target != null ? yFor(target) : null,
    baselineY,
    minKg,
    maxKg,
  };
}

// ---- localStorage I/O (SSR-safe) -------------------------------------------

export function loadWeightLog(): WeightEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WEIGHT_LOG_STORAGE_KEY);
    if (!raw) return [];
    return sanitizeEntries(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveWeightLog(entries: WeightEntry[]): void {
  if (typeof window === "undefined") return;
  // NO SWALLOW: a failed write (quota / private mode) MUST propagate so a
  // user-confirmed save never shows "保存 ✓" for data that did not persist
  // (phantom-success — Codex audit C2). Mirrors storage.ts writeJSON.
  window.localStorage.setItem(
    WEIGHT_LOG_STORAGE_KEY,
    JSON.stringify(entries.slice(-MAX_STORED)),
  );
  // A re-logged date supersedes any old tombstone for that date (weightLog ids are
  // the reused date), so re-entering a deleted day isn't re-suppressed by the
  // merge. When a tombstone was actually revived, push the cleared op too so
  // another device doesn't keep the old `deleted` op and re-suppress the re-logged
  // day (Codex review). No-op for a sync write of the excluded union.
  const revived = clearTombstones("weightLog", entries.map((e) => e.date).filter(Boolean));
  if (revived) pushSectionBestEffort("deletions");
  // Sync EVERY successful save immediately (Codex audit C2: a normal weight entry
  // must reach the server now, not only on the later visibility/pagehide flush or a
  // tombstone revival). No-op when logged out / suppressed during a sync write.
  pushSectionBestEffort("weightLog");
}

/**
 * Record (or update) today's weight and persist. Returns the new sorted log.
 * `date` defaults to today's local calendar day.
 */
export function logWeight(weightKg: number, date: string = toDateKey()): WeightEntry[] {
  const next = upsertEntry(loadWeightLog(), date, weightKg);
  saveWeightLog(next);
  return next;
}

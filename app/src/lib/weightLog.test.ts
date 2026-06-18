import { describe, it, expect } from "vitest";
import {
  sanitizeEntries,
  upsertEntry,
  latestEntry,
  remainingToTarget,
  buildBarGeometry,
  buildChartGeometry,
  toPolylinePoints,
  type WeightEntry,
  type ChartLayout,
  type BarChartLayout,
} from "./weightLog";

const e = (date: string, weightKg: number): WeightEntry => ({ date, weightKg });

describe("upsertEntry — add, update-same-day, sorting", () => {
  it("adds a new day's entry", () => {
    const out = upsertEntry([], "2026-06-10", 80);
    expect(out).toEqual([e("2026-06-10", 80)]);
  });

  it("updates (replaces) when the same day is re-entered", () => {
    const start = [e("2026-06-10", 80)];
    const out = upsertEntry(start, "2026-06-10", 79.4);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(e("2026-06-10", 79.4));
  });

  it("keeps entries sorted ascending by date", () => {
    let log: WeightEntry[] = [];
    log = upsertEntry(log, "2026-06-12", 78);
    log = upsertEntry(log, "2026-06-10", 80);
    log = upsertEntry(log, "2026-06-11", 79);
    expect(log.map((x) => x.date)).toEqual(["2026-06-10", "2026-06-11", "2026-06-12"]);
  });

  it("does not mutate the input array", () => {
    const start = [e("2026-06-10", 80)];
    const copy = [...start];
    upsertEntry(start, "2026-06-11", 79);
    expect(start).toEqual(copy);
  });
});

describe("latestEntry — most recent day", () => {
  it("returns null for an empty log", () => {
    expect(latestEntry([])).toBeNull();
  });

  it("returns the latest-dated entry regardless of insertion order", () => {
    const log = upsertEntry(upsertEntry([], "2026-06-12", 78), "2026-06-10", 80);
    expect(latestEntry(log)).toEqual(e("2026-06-12", 78));
  });
});

describe("sanitizeEntries — defensive load", () => {
  it("drops malformed rows and de-dupes by date (last wins), sorted", () => {
    const raw = [
      e("2026-06-11", 79),
      { date: "bad", weightKg: 70 },
      { date: "2026-06-10", weightKg: "x" },
      { date: "2026-06-10", weightKg: 0 }, // non-positive → dropped
      e("2026-06-10", 80),
      e("2026-06-10", 80.5), // duplicate day → wins
    ];
    expect(sanitizeEntries(raw)).toEqual([e("2026-06-10", 80.5), e("2026-06-11", 79)]);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeEntries(null)).toEqual([]);
    expect(sanitizeEntries("nope")).toEqual([]);
    expect(sanitizeEntries({})).toEqual([]);
  });
});

describe("remainingToTarget — 目標まであと何kg", () => {
  it("returns null when current or target is missing", () => {
    expect(remainingToTarget(null, 70)).toBeNull();
    expect(remainingToTarget(80, null)).toBeNull();
    expect(remainingToTarget(undefined, undefined)).toBeNull();
  });

  it("above target → lose, positive delta", () => {
    const r = remainingToTarget(80, 72)!;
    expect(r.delta).toBe(8);
    expect(r.abs).toBe(8);
    expect(r.direction).toBe("lose");
  });

  it("below target → gain, negative delta", () => {
    const r = remainingToTarget(68, 72)!;
    expect(r.delta).toBe(-4);
    expect(r.abs).toBe(4);
    expect(r.direction).toBe("gain");
  });

  it("at target → reached, zero", () => {
    const r = remainingToTarget(70, 70)!;
    expect(r.delta).toBe(0);
    expect(r.abs).toBe(0);
    expect(r.direction).toBe("reached");
  });

  it("rounds to 1 decimal", () => {
    const r = remainingToTarget(80.36, 72.0)!;
    expect(r.delta).toBe(8.4);
    expect(r.abs).toBe(8.4);
  });
});

describe("buildChartGeometry — point mapping for 0/1/many points", () => {
  const layout: ChartLayout = { width: 300, height: 120, padX: 12, padY: 12 };

  it("0 points → empty points array; target still mapped when present", () => {
    const g = buildChartGeometry([], 70, layout);
    expect(g.points).toEqual([]);
    expect(g.targetY).not.toBeNull();
    // target within the drawable band.
    expect(g.targetY!).toBeGreaterThanOrEqual(layout.padY);
    expect(g.targetY!).toBeLessThanOrEqual(layout.height - layout.padY);
  });

  it("0 points and no target → empty, no target line", () => {
    const g = buildChartGeometry([], null, layout);
    expect(g.points).toEqual([]);
    expect(g.targetY).toBeNull();
  });

  it("1 point → a single centered dot", () => {
    const g = buildChartGeometry([e("2026-06-10", 80)], null, layout);
    expect(g.points).toHaveLength(1);
    // centered horizontally: padX + innerW/2 = 12 + (300-24)/2 = 150
    expect(g.points[0].x).toBe(150);
    // y inside the band
    expect(g.points[0].y).toBeGreaterThanOrEqual(layout.padY);
    expect(g.points[0].y).toBeLessThanOrEqual(layout.height - layout.padY);
  });

  it("many points → first at left edge, last at right edge, ascending x", () => {
    const entries = [
      e("2026-06-10", 80),
      e("2026-06-11", 79.5),
      e("2026-06-12", 79),
      e("2026-06-13", 78.2),
    ];
    const g = buildChartGeometry(entries, 75, layout);
    expect(g.points).toHaveLength(4);
    expect(g.points[0].x).toBe(layout.padX); // 12
    expect(g.points[3].x).toBe(layout.width - layout.padX); // 288
    // x strictly increasing
    for (let i = 1; i < g.points.length; i++) {
      expect(g.points[i].x).toBeGreaterThan(g.points[i - 1].x);
    }
    // heaviest weight maps to the smallest y (highest on screen).
    const maxWeightPoint = g.points[0]; // 80 is the max
    const minY = Math.min(...g.points.map((p) => p.y));
    expect(maxWeightPoint.y).toBe(minY);
    expect(g.targetY).not.toBeNull();
  });

  it("flat data (all equal) maps without blowing up the range", () => {
    const entries = [e("2026-06-10", 70), e("2026-06-11", 70)];
    const g = buildChartGeometry(entries, null, layout);
    // both y values finite and within band
    for (const p of g.points) {
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeGreaterThanOrEqual(layout.padY);
      expect(p.y).toBeLessThanOrEqual(layout.height - layout.padY);
    }
    expect(g.minKg).toBeLessThan(70);
    expect(g.maxKg).toBeGreaterThan(70);
  });

  it("toPolylinePoints renders 'x,y x,y' string", () => {
    const entries = [e("2026-06-10", 80), e("2026-06-11", 79)];
    const g = buildChartGeometry(entries, null, layout);
    const str = toPolylinePoints(g.points);
    expect(str).toBe(`${g.points[0].x},${g.points[0].y} ${g.points[1].x},${g.points[1].y}`);
  });
});

describe("buildBarGeometry — bar mapping for 0/1/many points", () => {
  const layout: BarChartLayout = { width: 320, height: 160, padX: 16, padY: 20 };
  const baselineY = layout.height - layout.padY; // 140

  it("0 points → no bars; target still mapped within the band", () => {
    const g = buildBarGeometry([], 70, layout);
    expect(g.bars).toEqual([]);
    expect(g.baselineY).toBe(baselineY);
    expect(g.targetY).not.toBeNull();
    expect(g.targetY!).toBeGreaterThanOrEqual(layout.padY);
    expect(g.targetY!).toBeLessThanOrEqual(baselineY);
  });

  it("0 points and no target → no bars, no target line", () => {
    const g = buildBarGeometry([], null, layout);
    expect(g.bars).toEqual([]);
    expect(g.targetY).toBeNull();
  });

  it("1 point → a single centered, capped bar (not a lonely dot)", () => {
    const g = buildBarGeometry([e("2026-06-10", 80)], null, layout);
    expect(g.bars).toHaveLength(1);
    const bar = g.bars[0];
    // Centered horizontally across the inner width: padX + innerW/2.
    const innerW = layout.width - layout.padX * 2;
    expect(bar.cx).toBe(layout.padX + innerW / 2); // 16 + 288/2 = 160
    // Bar is capped (maxBarWidth=44) rather than spanning the whole slot.
    expect(bar.width).toBe(44);
    // Bar hangs down to the baseline.
    expect(bar.y + bar.height).toBeCloseTo(baselineY, 6);
    expect(bar.height).toBeGreaterThan(0);
    // Top stays inside the band.
    expect(bar.y).toBeGreaterThanOrEqual(layout.padY);
  });

  it("many points → evenly spaced, non-overlapping, ascending centers", () => {
    const entries = [
      e("2026-06-10", 80),
      e("2026-06-11", 79.5),
      e("2026-06-12", 79),
      e("2026-06-13", 78.2),
    ];
    const g = buildBarGeometry(entries, 75, layout);
    expect(g.bars).toHaveLength(4);
    // Centers strictly increasing, evenly spaced (one slot apart).
    const innerW = layout.width - layout.padX * 2;
    const slot = innerW / 4;
    for (let i = 0; i < g.bars.length; i++) {
      expect(g.bars[i].cx).toBeCloseTo(layout.padX + slot * (i + 0.5), 6);
      if (i > 0) expect(g.bars[i].cx).toBeGreaterThan(g.bars[i - 1].cx);
    }
    // Bars don't overlap (gap between them).
    for (let i = 1; i < g.bars.length; i++) {
      expect(g.bars[i].x).toBeGreaterThanOrEqual(
        g.bars[i - 1].x + g.bars[i - 1].width,
      );
    }
    // Bar-height mapping: heaviest weight (80) → tallest bar / smallest top y.
    const heights = g.bars.map((b) => b.height);
    expect(g.bars[0].height).toBe(Math.max(...heights));
    expect(g.bars[0].y).toBe(Math.min(...g.bars.map((b) => b.y)));
    // All bars hang to the baseline.
    for (const b of g.bars) {
      expect(b.y + b.height).toBeCloseTo(baselineY, 6);
    }
    expect(g.targetY).not.toBeNull();
  });

  it("target line sits between the bar tops it should (above heavier bars)", () => {
    const entries = [e("2026-06-10", 80), e("2026-06-11", 76)];
    const g = buildBarGeometry(entries, 78, layout);
    // 78 is between 76 and 80, so the line's y is between the two bar tops.
    const yHeavy = g.bars[0].y; // 80 → highest (smallest y)
    const yLight = g.bars[1].y; // 76 → lowest (largest y)
    expect(g.targetY!).toBeGreaterThan(yHeavy);
    expect(g.targetY!).toBeLessThan(yLight);
  });

  it("flat data (all equal) maps without blowing up the range", () => {
    const entries = [e("2026-06-10", 70), e("2026-06-11", 70)];
    const g = buildBarGeometry(entries, null, layout);
    for (const b of g.bars) {
      expect(Number.isFinite(b.y)).toBe(true);
      expect(Number.isFinite(b.height)).toBe(true);
      expect(b.height).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(layout.padY);
    }
    expect(g.minKg).toBeLessThan(70);
    expect(g.maxKg).toBeGreaterThan(70);
  });

  it("small goal gap (65kg vs 63kg target) does not exaggerate to a near-full-height gap", () => {
    // Reported bug: goal 63kg, current 65kg (~2kg to go). Auto-zooming the
    // y-domain to just {65, 63} (+15% pad → span ~2.6kg) made the bar fill ~88%
    // of the chart while the target line sat near the bottom — a 2kg gap looked
    // like a cliff. The MIN_SPAN_KG clamp widens the domain to ≥10kg so the gap
    // reads proportionally (~20% of the inner height instead of ~75%).
    const gapLayout: BarChartLayout = { width: 320, height: 168, padX: 16, padY: 22 };
    const innerH = gapLayout.height - gapLayout.padY * 2; // 124
    const g = buildBarGeometry([e("2026-06-10", 65)], 63, gapLayout);
    // The y-domain was widened to at least the 10kg minimum span (clamp applied).
    expect(g.maxKg - g.minKg).toBeGreaterThanOrEqual(10);
    // The single bar's top vs the target line is now a modest fraction of the
    // inner height (was ~75% before the fix; ~20% after).
    expect(g.targetY).not.toBeNull();
    expect(Math.abs(g.targetY! - g.bars[0].y)).toBeLessThan(innerH * 0.35);
  });
});

import { describe, it, expect } from "vitest";
import {
  haversineMeters,
  trackStats,
  avgSpeedKmh,
  classifyActivity,
  paceMinPerKm,
  formatKm,
  type GeoPoint,
} from "./cardioTracking";

const p = (lat: number, lng: number, tSec: number, accuracy = 5): GeoPoint => ({
  lat,
  lng,
  t: tSec * 1000,
  accuracy,
});

describe("haversineMeters", () => {
  it("≈111 m for 0.001° of latitude", () => {
    const d = haversineMeters(p(35.0, 139.0, 0), p(35.001, 139.0, 0));
    expect(d).toBeGreaterThan(108);
    expect(d).toBeLessThan(114);
  });
  it("is 0 for identical points", () => {
    expect(haversineMeters(p(35, 139, 0), p(35, 139, 1))).toBeCloseTo(0, 5);
  });
});

describe("trackStats", () => {
  it("accumulates distance over a steady walk", () => {
    // 4 points each ~111 m apart, 100 s apart → ~333 m total, 300 s.
    const pts = [
      p(35.0, 139.0, 0),
      p(35.001, 139.0, 100),
      p(35.002, 139.0, 200),
      p(35.003, 139.0, 300),
    ];
    const s = trackStats(pts);
    expect(s.distanceM).toBeGreaterThan(330);
    expect(s.distanceM).toBeLessThan(336);
    expect(s.durationSec).toBe(300);
    expect(s.keptPoints).toBe(4);
  });

  it("drops low-accuracy points", () => {
    const pts = [
      p(35.0, 139.0, 0, 5),
      p(35.001, 139.0, 100, 200), // bad accuracy → dropped
      p(35.002, 139.0, 200, 5),
    ];
    const s = trackStats(pts);
    expect(s.keptPoints).toBe(2);
    // distance is straight 35.000 → 35.002 ≈ 222 m
    expect(s.distanceM).toBeGreaterThan(219);
    expect(s.distanceM).toBeLessThan(225);
  });

  it("ignores standing-still jitter (tiny segments)", () => {
    const pts = [
      p(35.0, 139.0, 0),
      p(35.00001, 139.0, 10), // ~1 m → below minSegment, not counted
      p(35.0, 139.0, 20),
    ];
    const s = trackStats(pts);
    expect(s.distanceM).toBe(0);
  });

  it("skips an impossible GPS jump", () => {
    const pts = [
      p(35.0, 139.0, 0),
      p(36.0, 139.0, 1), // ~111 km in 1 s → impossible, skipped
      p(36.001, 139.0, 100), // counts from the jump point onward (~111 m)
    ];
    const s = trackStats(pts);
    expect(s.distanceM).toBeLessThan(200); // the 111 km jump is NOT added
  });

  it("returns zeros for fewer than 2 good points", () => {
    expect(trackStats([p(35, 139, 0)]).distanceM).toBe(0);
  });

  it("does NOT count drift while standing still (GPS speed ~0)", () => {
    // The fix wanders ~10 m but the GPS speed says we're stopped → distance stays 0.
    const sp = (lat: number, lng: number, tSec: number, speed: number): GeoPoint => ({
      lat,
      lng,
      t: tSec * 1000,
      accuracy: 8,
      speed,
    });
    const pts = [
      sp(35.0, 139.0, 0, 0),
      sp(35.00009, 139.0, 5, 0.1), // ~10 m drift but speed≈0 (standing)
      sp(35.0, 139.0, 10, 0.0),
    ];
    expect(trackStats(pts).distanceM).toBe(0);
  });

  it("does NOT count drift while standing — even WITHOUT GPS speed (anchor radius)", () => {
    // No speed field. The fix wiggles within ~7 m of accuracy 10 → never escapes the
    // drift radius → distance stays 0. This is the real-device fix (devices that
    // report no GPS speed must still not accumulate while sitting).
    const wig = (latOff: number, tSec: number): GeoPoint => ({
      lat: 35.0 + latOff,
      lng: 139.0,
      t: tSec * 1000,
      accuracy: 10,
    });
    const pts = [wig(0, 0), wig(0.00005, 5), wig(-0.00004, 10), wig(0.00006, 15), wig(0, 20)];
    expect(trackStats(pts).distanceM).toBe(0);
  });

  it("counts real movement that escapes the drift radius (no GPS speed)", () => {
    const pt = (latOff: number, tSec: number): GeoPoint => ({
      lat: 35.0 + latOff,
      lng: 139.0,
      t: tSec * 1000,
      accuracy: 8,
    });
    const pts = [pt(0, 0), pt(0.001, 30)]; // ~111 m → escapes the 8 m radius
    expect(trackStats(pts).distanceM).toBeGreaterThan(108);
  });

  it("counts a segment when GPS speed says we're moving", () => {
    const sp = (lat: number, lng: number, tSec: number, speed: number): GeoPoint => ({
      lat,
      lng,
      t: tSec * 1000,
      accuracy: 8,
      speed,
    });
    const pts = [
      sp(35.0, 139.0, 0, 1.4),
      sp(35.001, 139.0, 80, 1.4), // ~111 m, speed 1.4 m/s ≈ 5 km/h → moving
    ];
    expect(trackStats(pts).distanceM).toBeGreaterThan(108);
  });

  it("movingSec EXCLUDES a standing-still gap → pace stays stable when you stop", () => {
    // Regression for the "止まるとペースがむしろ上がる" bug: pace/speed must be over
    // MOVING time, not wall-clock elapsed. Here the user walks for 60 s, then stands
    // still (same spot, GPS speed ≈ 0) for another 60 s while the clock runs to 120 s.
    const sp = (lat: number, lng: number, tSec: number, speed: number): GeoPoint => ({
      lat,
      lng,
      t: tSec * 1000,
      accuracy: 8,
      speed,
    });
    // Phase 1 — walk north ~5 km/h (1.4 m/s) for 60 s (~83 m of real movement).
    const moving = [
      sp(35.0, 139.0, 0, 1.4),
      sp(35.00025, 139.0, 20, 1.4),
      sp(35.0005, 139.0, 40, 1.4),
      sp(35.00075, 139.0, 60, 1.4),
    ];
    const a = trackStats(moving);
    expect(a.movingSec).toBeGreaterThan(55);
    expect(a.movingSec).toBeLessThan(65); // ≈ 60 s of moving
    const paceMoving = paceMinPerKm(a.distanceM, a.movingSec);
    expect(paceMoving).not.toBe(""); // a real pace was produced

    // Phase 2 — STAND STILL at the same spot for 60 s more (speed ≈ 0). Wall clock
    // advances to 120 s; distance and movingSec must NOT.
    const withIdle = [
      ...moving,
      sp(35.00075, 139.0, 80, 0.0),
      sp(35.00075, 139.0, 100, 0.05),
      sp(35.00075, 139.0, 120, 0.0),
    ];
    const b = trackStats(withIdle);

    // movingSec did NOT grow during the idle (still ≈ 60, NOT ≈ 120).
    expect(b.movingSec).toBeGreaterThan(55);
    expect(b.movingSec).toBeLessThan(65);
    // Distance is unchanged across the idle (no movement was added).
    expect(b.distanceM).toBeCloseTo(a.distanceM, 6);
    // durationSec (point span) DID grow to ~120 s — proving wall time advanced...
    expect(b.durationSec).toBe(120);
    // ...yet pace over movingSec is IDENTICAL across the idle (does NOT climb/worsen).
    expect(paceMinPerKm(b.distanceM, b.movingSec)).toBe(paceMoving);
    // And the OLD (buggy) pace over total elapsed WOULD have degraded — proof the
    // moving-time denominator is what fixes it.
    expect(paceMinPerKm(b.distanceM, b.durationSec)).not.toBe(paceMoving);
  });
});

describe("avgSpeedKmh", () => {
  it("computes km/h from m and s", () => {
    expect(avgSpeedKmh(1000, 360)).toBeCloseTo(10, 5); // 1km in 6min = 10km/h
    expect(avgSpeedKmh(100, 0)).toBe(0);
  });
});

describe("classifyActivity", () => {
  it("walk / run / bike by speed", () => {
    expect(classifyActivity(4).kind).toBe("walk");
    expect(classifyActivity(6.5).kind).toBe("run");
    expect(classifyActivity(10).kind).toBe("run");
    expect(classifyActivity(20).kind).toBe("bike");
  });
  it("emits names that burn.ts recognises", () => {
    expect(classifyActivity(4).name).toBe("ウォーキング");
    expect(classifyActivity(10).name).toBe("ランニング");
    expect(classifyActivity(20).name).toBe("サイクリング");
  });
});

describe("paceMinPerKm / formatKm", () => {
  it("formats pace", () => {
    expect(paceMinPerKm(1000, 360)).toBe("6'00\"/km"); // 6 min/km
    expect(paceMinPerKm(0, 100)).toBe("");
  });
  it("formats distance in km", () => {
    expect(formatKm(840)).toBe("0.84 km");
    expect(formatKm(1230)).toBe("1.23 km");
  });
});

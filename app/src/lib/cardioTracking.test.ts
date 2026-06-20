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

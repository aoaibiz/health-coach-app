// cardioTracking.ts — pure, testable core for the GPS aerobic-exercise feature.
//
// The browser's Geolocation API streams {lat, lng, accuracy, t} points while the
// user walks / runs / cycles (foreground, screen on — a PWA can't track reliably
// in the background). These pure functions turn that stream into a distance, a
// moving time, an average pace, and a walk/run/bike classification. The page layer
// (cardio page) owns geolocation + Wake Lock; everything numeric lives here so it
// is unit-tested with no browser.
//
// HONESTY: distance is GPS-measured (real), classification + the calorie burn are
// LABELED ESTIMATES. The activity name we emit matches burn.ts's MET table
// (ウォーキング / ランニング / サイクリング) so the EXISTING burn estimate
// (MET × 体重 × 時間, Compendium of Physical Activities) computes the calories —
// we never invent a calorie number here.

export interface GeoPoint {
  lat: number;
  lng: number;
  /** epoch ms */
  t: number;
  /** GPS accuracy radius in metres (lower = better); optional. */
  accuracy?: number;
}

const EARTH_R_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance between two lat/lng points, in metres (haversine). */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface TrackOptions {
  /** Drop a point whose accuracy is worse (larger) than this many metres. */
  maxAccuracyM?: number;
  /** Ignore a segment implying a speed above this (km/h) — a GPS jump. */
  maxSpeedKmh?: number;
  /** Ignore a segment shorter than this (metres) — GPS jitter while still. */
  minSegmentM?: number;
}

const DEFAULT_TRACK_OPTS: Required<TrackOptions> = {
  maxAccuracyM: 40,
  maxSpeedKmh: 80, // faster than any walk/run/bike → a GPS glitch
  minSegmentM: 3, // below this is standing-still jitter
};

export interface TrackStats {
  /** Accumulated distance in metres (noise-filtered). */
  distanceM: number;
  /** Wall-clock seconds from first to last kept point. */
  durationSec: number;
  /** Number of points that passed the accuracy filter. */
  keptPoints: number;
}

/**
 * Accumulate the noise-filtered distance + duration over an ordered point list.
 * Filters: points worse than maxAccuracyM are dropped; segments that are jitter
 * (< minSegmentM) or physically impossible (> maxSpeedKmh) are not added to the
 * distance (but time still advances). Pure — no clock, no DOM.
 */
export function trackStats(points: GeoPoint[], opts: TrackOptions = {}): TrackStats {
  const o = { ...DEFAULT_TRACK_OPTS, ...opts };
  const kept = points.filter((p) => (p.accuracy ?? 0) <= o.maxAccuracyM);
  if (kept.length < 2) {
    return { distanceM: 0, durationSec: 0, keptPoints: kept.length };
  }
  let distanceM = 0;
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1];
    const b = kept[i];
    const seg = haversineMeters(a, b);
    const dtSec = Math.max(0, (b.t - a.t) / 1000);
    if (seg < o.minSegmentM) continue; // standing-still jitter
    const segSpeedKmh = dtSec > 0 ? (seg / dtSec) * 3.6 : Infinity;
    if (segSpeedKmh > o.maxSpeedKmh) continue; // GPS jump — skip the segment
    distanceM += seg;
  }
  const durationSec = Math.max(0, (kept[kept.length - 1].t - kept[0].t) / 1000);
  return { distanceM, durationSec, keptPoints: kept.length };
}

/** Average speed (km/h) for a distance/time; 0 when time is non-positive. */
export function avgSpeedKmh(distanceM: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return (distanceM / durationSec) * 3.6;
}

export type CardioKind = "walk" | "run" | "bike";

export interface CardioActivity {
  kind: CardioKind;
  /** Japanese name that burn.ts's MET table recognises (drives the calorie burn). */
  name: string;
  /** Short label for the UI. */
  label: string;
}

export const CARDIO_ACTIVITIES: Record<CardioKind, CardioActivity> = {
  walk: { kind: "walk", name: "ウォーキング", label: "歩き" },
  run: { kind: "run", name: "ランニング", label: "ラン" },
  bike: { kind: "bike", name: "サイクリング", label: "自転車" },
};

/**
 * Classify the activity from average speed (km/h) — a best-guess DEFAULT the user
 * can override. Thresholds: < 6.5 walk, 6.5–14 run, > 14 bike. There is genuine
 * overlap (a fast runner ~15 km/h vs a slow cyclist), so the UI lets the user pick
 * the correct one; this only seeds the initial choice.
 */
export function classifyActivity(speedKmh: number): CardioActivity {
  if (speedKmh > 14) return CARDIO_ACTIVITIES.bike;
  if (speedKmh >= 6.5) return CARDIO_ACTIVITIES.run;
  return CARDIO_ACTIVITIES.walk;
}

/** Pace string "m'ss"/km" for walk/run (min per km); empty when no distance. */
export function paceMinPerKm(distanceM: number, durationSec: number): string {
  if (distanceM < 1 || durationSec <= 0) return "";
  const secPerKm = durationSec / (distanceM / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}'${String(s).padStart(2, "0")}"/km`;
}

/** Format metres as a friendly distance: "0.84 km" / "1,230 m" style → km with 2dp. */
export function formatKm(distanceM: number): string {
  return `${(distanceM / 1000).toFixed(2)} km`;
}

// Structured auto-log protocol for WORKOUTS (chat→筋トレ/運動 flow). The text
// twin of mealLogProtocol.ts: when the super-trainer (健康マン) has gathered
// enough to log a workout, its reply carries — alongside the natural prose — a
// single fenced sentinel block describing WHICH exercises/sets to log. The client
// detects the block, parses it, STRIPS it from the displayed text (the user only
// ever sees natural Japanese — never raw JSON), and grounds every exercise
// through the EXISTING workout libs (burn.ts MET estimate + workoutSets volume).
//
// ┌─ FABRICATION SAFETY (the hard rule) ──────────────────────────────────────┐
// │ The block carries only exercises (name + sets [weight×reps] OR durationMin │
// │ + optional intensity). The NUMBERS that get LOGGED are computed by the      │
// │ grounded libs, NOT read from the model:                                     │
// │   - 総挙上量 (volume) = exact Σ(weight × reps) over the sets (workoutSets);  │
// │     bodyweight moves contribute 0 (the 120kg-phantom fix).                  │
// │   - 消費kcal = MET × bodyweight × time (burn.ts), shown as 推定.             │
// │ The model NEVER writes an authoritative kcal/volume number; an unknown      │
// │ exercise resolves to a reasonable MET default, never a fabricated figure.   │
// └────────────────────────────────────────────────────────────────────────────┘
//
// PURE + framework-free (no DOM, no network) so the parse/strip is unit-tested
// in isolation and reused verbatim by the chat client.

import type { IntensityLevel } from "./types";
import { parseLogMode, type LogMode } from "./mealLogProtocol";

/** The sentinel that fences the structured workout block (mirrors MEAL_LOG). */
export const WORKOUT_LOG_OPEN = "«WORKOUT_LOG»";
export const WORKOUT_LOG_CLOSE = "«/WORKOUT_LOG»";

/** One set the model asks us to log: weight (kg, 0 = bodyweight) × reps. */
export interface WorkoutLogSetPayload {
  /** Weight in kg. 0 / omitted = bodyweight (no phantom load). */
  weight?: number;
  reps: number;
}

/** One exercise in a workout block. Either sets (strength) OR durationMin (cardio). */
export interface WorkoutLogExercisePayload {
  name: string;
  /** Per-set weight×reps for a strength move. */
  sets?: WorkoutLogSetPayload[];
  /** Active minutes for a cardio move (running/walking/cycling/swim). */
  durationMin?: number;
  /** Effort level — scales the MET (light/moderate/hard). Optional → moderate. */
  intensity?: IntensityLevel;
}

/** The full parsed workout auto-log payload. */
export interface WorkoutLogPayload {
  exercises: WorkoutLogExercisePayload[];
  /** new = append a distinct workout (default); correct = update the last logged one. */
  mode?: LogMode;
}

const INTENSITY_SET = new Set<IntensityLevel>(["light", "moderate", "hard"]);

/** A finite, non-negative number or undefined (drops garbage/negatives). */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Coerce one raw set into a clean WorkoutLogSetPayload, or null if unusable. */
function toSet(raw: unknown): WorkoutLogSetPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const reps = num(r.reps);
  // reps is required for a set; without it there's no effort to log.
  if (reps === undefined || reps <= 0) return null;
  const set: WorkoutLogSetPayload = { reps };
  const weight = num(r.weight);
  if (weight !== undefined) set.weight = weight;
  return set;
}

/** Coerce one raw exercise into a clean payload, or null if unusable. */
function toExercise(raw: unknown): WorkoutLogExercisePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;

  const ex: WorkoutLogExercisePayload = { name };

  const rawSets = r.sets;
  if (Array.isArray(rawSets)) {
    const sets = rawSets.map(toSet).filter((s): s is WorkoutLogSetPayload => s !== null);
    if (sets.length > 0) ex.sets = sets;
  }
  const duration = num(r.durationMin);
  if (duration !== undefined && duration > 0) ex.durationMin = duration;

  // Must carry SOME effort to be loggable: at least one valid set OR a duration.
  if (!ex.sets && ex.durationMin === undefined) return null;

  if (typeof r.intensity === "string" && INTENSITY_SET.has(r.intensity as IntensityLevel)) {
    ex.intensity = r.intensity as IntensityLevel;
  }
  return ex;
}

/**
 * The result of scanning a coach reply for a WORKOUT_LOG block: the prose to
 * DISPLAY (block stripped) and the parsed payload (or null when none/invalid).
 * Like the meal path, the block is ALWAYS stripped — even when malformed — so
 * raw JSON can never reach the user, and a half-parsed workout is never logged.
 */
export interface ParsedWorkoutReply {
  display: string;
  payload: WorkoutLogPayload | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the FIRST workout sentinel block (non-greedy), capturing its inner text. */
const BLOCK_RE = new RegExp(
  `${escapeRegExp(WORKOUT_LOG_OPEN)}([\\s\\S]*?)${escapeRegExp(WORKOUT_LOG_CLOSE)}`,
);

/** Parse the inner JSON of a workout block, tolerant of a ```json fence. */
function parseBlockBody(body: string): WorkoutLogPayload | null {
  let text = body.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(text);
  if (fence) text = fence[1].trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rawEx = (parsed as { exercises?: unknown }).exercises;
  if (!Array.isArray(rawEx)) return null;
  const exercises = rawEx
    .map(toExercise)
    .filter((e): e is WorkoutLogExercisePayload => e !== null);
  if (exercises.length === 0) return null;

  return {
    exercises,
    mode: parseLogMode((parsed as { mode?: unknown }).mode),
  };
}

/**
 * Scan a raw coach reply for the WORKOUT_LOG block. Returns the display text with
 * the block removed plus the parsed payload. ALWAYS strips the block — even when
 * malformed — so raw JSON never reaches the user. No block → display is the input
 * trimmed and payload is null.
 */
export function parseWorkoutReply(raw: string): ParsedWorkoutReply {
  const match = BLOCK_RE.exec(raw);
  if (!match) {
    return { display: raw.trim(), payload: null };
  }
  const payload = parseBlockBody(match[1]);
  const display = raw.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { display, payload };
}

/** True when a reply contains a (possibly malformed) workout block. */
export function hasWorkoutLogBlock(raw: string): boolean {
  return BLOCK_RE.test(raw);
}

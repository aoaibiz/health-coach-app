// Structured WORKOUT_PLAN protocol (chat→運動メニュー提案フロー, AIプランナー 第2陣C).
//
// THE PLAN CHANNEL (the twin of workoutLogProtocol.ts, but for FUTURE intent). When
// the coach has asked the user the start time, read their recent training + goals,
// and the user CONFIRMS a proposed workout menu, the coach's reply carries —
// alongside the natural prose — a single fenced sentinel block describing the
// exercises to PLAN (not log as done) plus the start/end time of the session. The
// client detects that block, parses + validates it, STRIPS it from the displayed
// text (the user only ever sees natural Japanese, never raw JSON), and then:
//   ① bulk-inserts the exercises into TODAY's workout as `status:"planned"` (so the
//      筋トレ画面 shows them with a 完了 button, but they don't inflate 成果/消費kcal
//      until the user marks each done);
//   ② when start/end are present, reflects the session onto the calendar via the
//      EXISTING CALENDAR_PLAN path (one トレーニング event) — no new write channel.
//
// ┌─ FABRICATION SAFETY ──────────────────────────────────────────────────────┐
// │ This is a PROPOSAL the user confirmed, not a record of what they did. The   │
// │ exercises are grounded by the SAME buildLoggedExercise path as the workout  │
// │ log (volume = exact Σ weight×reps; burn = MET estimate), and they are       │
// │ inserted as `planned`, so 成果/履歴 stay truthful (a plan ≠ done). The model │
// │ writes only names + sets/reps/(weight)/(minutes) + the session time — never  │
// │ an authoritative kcal/volume number. A missing/bad time DROPS the calendar   │
// │ reflection (the plan still inserts); zero usable exercises → null payload.    │
// └────────────────────────────────────────────────────────────────────────────┘
//
// PURE + framework-free (no DOM, no network) so the parse/strip is unit-tested in
// isolation and reused verbatim by the chat client. The exercise coercion is the
// SAME as workoutLogProtocol so a planned exercise is identical in shape to a
// logged one (only its status differs at insert time).

import { parseLogMode, type LogMode } from "./mealLogProtocol";
import type { WorkoutLogExercisePayload } from "./workoutLogProtocol";
import type { IntensityLevel } from "./types";

/** The sentinel that fences the structured workout-PLAN block (distinct from the
 *  WORKOUT_LOG sentinel so the two flows never collide). Kept in sync with
 *  functions/_llm/chat-prompt.ts WORKOUT_PLAN_OPEN/CLOSE. */
export const WORKOUT_PLAN_OPEN = "«WORKOUT_PLAN»";
export const WORKOUT_PLAN_CLOSE = "«/WORKOUT_PLAN»";

/** The full parsed workout-PLAN payload: exercises to plan + optional session time. */
export interface WorkoutPlanPayload {
  /** The exercises to insert as `planned` (same shape as the log path). */
  exercises: WorkoutLogExercisePayload[];
  /** RFC3339-with-zone session start, when the coach gave one (for the calendar). */
  start?: string;
  /** RFC3339-with-zone session end, when the coach gave one (end > start). */
  end?: string;
  /** new = add a fresh plan (default); correct = replace the last planned batch. */
  mode?: LogMode;
}

const INTENSITY_SET = new Set<IntensityLevel>(["light", "moderate", "hard"]);

/** A finite, non-negative number or undefined (drops garbage/negatives). */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Coerce one raw set into a clean payload set, or null if unusable. Mirrors
 *  workoutLogProtocol.toSet so a planned set is identical to a logged one. */
function toSet(raw: unknown): { weight?: number; reps: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const reps = num(r.reps);
  if (reps === undefined || reps <= 0) return null;
  const set: { weight?: number; reps: number } = { reps };
  const weight = num(r.weight);
  if (weight !== undefined) set.weight = weight;
  return set;
}

/** Coerce one raw exercise into a clean payload, or null if unusable. Mirrors
 *  workoutLogProtocol.toExercise exactly (same grounding contract). */
function toExercise(raw: unknown): WorkoutLogExercisePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;

  const ex: WorkoutLogExercisePayload = { name };

  const rawSets = r.sets;
  if (Array.isArray(rawSets)) {
    const sets = rawSets.map(toSet).filter((s): s is { weight?: number; reps: number } => s !== null);
    if (sets.length > 0) ex.sets = sets;
  }
  const duration = num(r.durationMin);
  if (duration !== undefined && duration > 0) ex.durationMin = duration;

  // Must carry SOME effort to be a usable plan item: ≥1 valid set OR a duration.
  if (!ex.sets && ex.durationMin === undefined) return null;

  if (typeof r.intensity === "string" && INTENSITY_SET.has(r.intensity as IntensityLevel)) {
    ex.intensity = r.intensity as IntensityLevel;
  }
  return ex;
}

/** RFC3339 with date + time + an explicit zone (offset or Z) — same as the
 *  calendar-plan validator, so a planned session time matches the calendar's. */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A valid RFC3339-with-zone datetime that actually parses, else null. */
function validDateTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!RFC3339_RE.test(s)) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

/**
 * The result of scanning a coach reply for a WORKOUT_PLAN block: the prose to
 * DISPLAY (block stripped) and the parsed payload (or null when none/invalid).
 * Like the log path, the block is ALWAYS stripped — even when malformed — so raw
 * JSON can never reach the user, and a half-parsed plan is never inserted.
 */
export interface ParsedWorkoutPlanReply {
  display: string;
  payload: WorkoutPlanPayload | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the FIRST workout-plan sentinel block (non-greedy), capturing inner text. */
const BLOCK_RE = new RegExp(
  `${escapeRegExp(WORKOUT_PLAN_OPEN)}([\\s\\S]*?)${escapeRegExp(WORKOUT_PLAN_CLOSE)}`,
);

/** Parse the inner JSON of a workout-plan block, tolerant of a ```json fence. */
function parseBlockBody(body: string): WorkoutPlanPayload | null {
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

  const payload: WorkoutPlanPayload = {
    exercises,
    mode: parseLogMode((parsed as { mode?: unknown }).mode),
  };

  // Session time is OPTIONAL: only attach start+end when BOTH are valid
  // zone-aware datetimes AND end > start. A bad/partial/zoneless time drops the
  // calendar reflection entirely (the plan still inserts) — never an invented time.
  const start = validDateTime((parsed as { start?: unknown }).start);
  const end = validDateTime((parsed as { end?: unknown }).end);
  if (start && end && Date.parse(end) > Date.parse(start)) {
    payload.start = start;
    payload.end = end;
  }

  return payload;
}

/**
 * Scan a raw coach reply for the WORKOUT_PLAN block. Returns the display text with
 * the block removed (ALWAYS stripped — even when malformed, so raw JSON never
 * reaches the user) plus the parsed payload (null when none/invalid).
 */
export function parseWorkoutPlanReply(raw: string): ParsedWorkoutPlanReply {
  const match = BLOCK_RE.exec(raw);
  if (!match) return { display: raw.trim(), payload: null };
  const payload = parseBlockBody(match[1]);
  const display = raw.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { display, payload };
}

/** True when a reply contains a (possibly malformed) WORKOUT_PLAN block. */
export function hasWorkoutPlanBlock(raw: string): boolean {
  return BLOCK_RE.test(raw);
}

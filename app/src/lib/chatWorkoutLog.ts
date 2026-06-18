// Chat→筋トレ/運動 auto-log glue (the text twin of chatMealLog.ts). Two pure
// steps, both unit-testable with no DOM/network:
//   1. buildLoggedExercise — turn one parsed workout-block exercise into a
//      grounded Exercise. Strength moves get per-set weight×reps via workoutSets
//      (volume = exact Σ weight×reps); cardio gets durationMin. The model NEVER
//      writes the kcal/volume — those are computed by burn.ts / workout.ts.
//   2. applyWorkoutLog — write a parsed payload into the per-day workout store
//      with the SAME explicit + persistent de-dupe as meals (mode new/correct
//      resolved against persisted chat history), so it flows to 成果 + calendar.
//
// FABRICATION SAFETY: the grounded Exercise carries only what the user did
// (names, sets, reps, weight, minutes, effort). 総挙上量 is the EXACT Σ(weight×
// reps) computed by workoutSets (bodyweight → 0, the phantom-weight fix); 消費kcal
// is the MET-based estimate from burn.ts (labelled 推定). Nothing is invented.

import type { Exercise, Workout } from "./types";
import { makeSet, syncLegacyFields } from "./workoutSets";
import { isCardioName } from "./burn";
import { makeId, toDateKey } from "./date";
import type {
  WorkoutLogExercisePayload,
  WorkoutLogPayload,
} from "./workoutLogProtocol";

/** Default reps when an exercise carries neither sets nor a duration (defensive). */
const DEFAULT_REPS = 10;

/**
 * Build a grounded Exercise from one workout-block exercise. The NUMBERS that
 * matter (volume, burn) are derived by the grounded libs, not the model:
 *   - sets present → per-set weight×reps via makeSet + syncLegacyFields, so
 *     volume = exact Σ(weight×reps). A 0/absent weight stays bodyweight (no
 *     phantom load); burn.ts decides bodyweight-exclusion by NAME, so e.g.
 *     腹筋 with weight contributes 0 to 総挙上量 regardless.
 *   - durationMin present (cardio) → time-based burn (MET × kg × time); no sets,
 *     so it contributes 0 to 総挙上量 (correct — cardio carries no external load).
 *   - intensity (light/moderate/hard) scales the MET; absent → moderate (1.0×).
 *
 * Returns null only for a totally empty/unusable exercise (defensive; the parser
 * already drops those).
 */
export function buildLoggedExercise(
  payload: WorkoutLogExercisePayload,
  opts: { id?: string; makeSetId?: () => string } = {},
): Exercise | null {
  const name = payload.name.trim();
  if (!name) return null;
  const id = opts.id ?? makeId();
  const makeSetId = opts.makeSetId ?? makeId;

  const base: Exercise = {
    id,
    name,
    sets: 0,
    reps: 0,
    weight: 0,
    ...(payload.intensity ? { intensity: payload.intensity } : {}),
  };

  // Cardio (time-based) or an exercise the model gave only a duration: keep it
  // time-based so the burn uses minutes; no setEntries → 0 volume (no phantom).
  if (payload.durationMin !== undefined && payload.durationMin > 0 && !payload.sets) {
    return { ...base, durationMin: payload.durationMin };
  }

  // Strength (or anything with sets): per-set weight×reps → exact volume.
  if (payload.sets && payload.sets.length > 0) {
    const setEntries = payload.sets.map((s) => makeSet(makeSetId(), s.weight ?? 0, s.reps));
    const ex = syncLegacyFields(base, setEntries);
    // A cardio name that somehow arrived with sets still gets a duration so its
    // burn is time-based (defensive — the prompt routes cardio to durationMin).
    if (payload.durationMin !== undefined && payload.durationMin > 0) {
      return { ...ex, durationMin: payload.durationMin };
    }
    return ex;
  }

  // Neither sets nor duration: a bare cardio name → default duration (time-based);
  // anything else → a single default-rep bodyweight set so it still logs honestly.
  if (isCardioName(name)) {
    return { ...base, durationMin: 0 }; // burn.ts uses DEFAULT_DURATION_MIN
  }
  return syncLegacyFields(base, [makeSet(makeSetId(), 0, DEFAULT_REPS)]);
}

/** Ground every exercise in a workout payload (chat→筋トレ). Never fabricates. */
export function buildLoggedExercises(
  payload: WorkoutLogPayload,
  makeSetId?: () => string,
): Exercise[] {
  return payload.exercises
    .map((e) => buildLoggedExercise(e, makeSetId ? { makeSetId } : {}))
    .filter((e): e is Exercise => e !== null);
}

/**
 * The result of applying one WORKOUT_LOG payload against the per-day store.
 * `workouts` is the next store record to persist; `exerciseIds` are the ids of
 * the exercises this turn logged/updated (recorded on the assistant chat message
 * so a later "correct" turn can resolve them from persisted history). `date` is
 * the day they were logged to. `exerciseCount` backs the "筋トレを記録しました" chip.
 */
export interface ApplyWorkoutLogResult {
  workouts: Record<string, Workout>;
  exerciseIds: string[];
  date: string;
  exerciseCount: number;
}

/**
 * Apply ONE WORKOUT_LOG payload with EXPLICIT, PERSISTENT de-dupe — the workout
 * twin of applyMealLog. The dedupe signal is carried in the block (`payload.mode`)
 * and resolved against the PERSISTED chat history, not an in-memory ref:
 *
 *   - mode "new" (default): APPEND the grounded exercises to today's workout as a
 *     distinct logged batch. A genuinely new workout — even right after another —
 *     is always new entries (no over-merge).
 *   - mode "correct": REPLACE the exercises this chat last logged (identified by
 *     `correctIds`, resolved by the caller from the assistant message that carried
 *     `loggedWorkout`) with the freshly grounded ones, in place, keeping the same
 *     ids where possible. Survives reload (history persisted); after clear() there
 *     is no history → correctIds empty → it safely APPENDS.
 *
 * A "correct" whose target ids are all gone from the store (deleted on the 筋トレ
 * page) safely APPENDS — no ghost update. Idempotent: a repeated "correct"
 * re-grounds the same batch rather than duplicating it.
 *
 * FABRICATION SAFETY is unchanged: each Exercise is built by buildLoggedExercise,
 * whose volume/burn come ONLY from the grounded libs — never from the model.
 *
 * Returns null when nothing groundable remains.
 */
export function applyWorkoutLog(
  payload: WorkoutLogPayload,
  opts: {
    workouts: Record<string, Workout>;
    /** Ids of the exercises this chat last logged (for mode "correct"). */
    correctIds?: string[] | null;
    date?: string;
    now?: Date;
    makeSetId?: () => string;
  },
): ApplyWorkoutLogResult | null {
  const date = opts.date ?? toDateKey();
  const now = opts.now ?? new Date();
  const mode = payload.mode ?? "new";

  const day: Workout = opts.workouts[date] ?? {
    date,
    exercises: [],
    updatedAt: now.toISOString(),
  };

  const correctIds = mode === "correct" && opts.correctIds ? opts.correctIds : [];
  // A "correct" only updates in place when at least one target still exists in
  // today's workout; otherwise it falls through to APPEND (no ghost update).
  const targetsPresent =
    correctIds.length > 0 && day.exercises.some((e) => correctIds.includes(e.id));

  // Build fresh grounded exercises. On a correct with present targets, reuse the
  // first N existing ids so the entries keep their identity across the update.
  const fresh = payload.exercises
    .map((p, i) => {
      const reuseId = targetsPresent ? correctIds[i] : undefined;
      return buildLoggedExercise(
        p,
        opts.makeSetId
          ? { id: reuseId, makeSetId: opts.makeSetId }
          : reuseId
            ? { id: reuseId }
            : {},
      );
    })
    .filter((e): e is Exercise => e !== null);
  if (fresh.length === 0) return null;

  let nextExercises: Exercise[];
  if (targetsPresent) {
    // Drop the previously-logged batch, then append the regrounded one (so a
    // correction that changes the exercise COUNT doesn't leave orphans).
    nextExercises = [...day.exercises.filter((e) => !correctIds.includes(e.id)), ...fresh];
  } else {
    nextExercises = [...day.exercises, ...fresh];
  }

  const nextDay: Workout = { date, exercises: nextExercises, updatedAt: now.toISOString() };
  return {
    workouts: { ...opts.workouts, [date]: nextDay },
    exerciseIds: fresh.map((e) => e.id),
    date,
    exerciseCount: fresh.length,
  };
}

/**
 * Resolve the exercise ids the chat last logged from the PERSISTED chat history —
 * the targets a "correct" workout block updates. Scans newest-first for an
 * assistant turn carrying `loggedWorkout` and returns its exerciseIds, or null
 * when none (fresh chat / after clear()). Pure + reload-safe by construction.
 */
export function lastLoggedWorkoutIds(
  messages: ReadonlyArray<{
    role: string;
    loggedWorkout?: { exerciseIds: string[] } | undefined;
  }>,
): string[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.loggedWorkout?.exerciseIds?.length) {
      return m.loggedWorkout.exerciseIds;
    }
  }
  return null;
}

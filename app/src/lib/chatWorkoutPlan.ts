// Chat→運動メニュー提案フロー applier (AIプランナー 第2陣C). The twin of
// chatWorkoutLog.ts, but for a PLAN (future intent) the user confirmed, not a
// record of what they did. Two pure steps, both unit-testable with no DOM/network:
//   1. applyWorkoutPlan — bulk-insert the proposed exercises into TODAY's workout
//      as `status:"planned"`, with the SAME new/correct de-dupe as the log path
//      (so a "correct" replaces the last planned batch, not a done one). The
//      exercises are grounded by the SAME buildLoggedExercise path as the log,
//      so a planned 種目 is byte-identical to a logged one except its status —
//      then 完了 (updateExercise) flips it to done and it starts counting.
//   2. planToCalendarPayload — when the plan carries a session start/end, build a
//      CALENDAR_PLAN payload (one トレーニング event) so the EXISTING calendar path
//      reflects the session onto the user's Google Calendar (no new write channel).
//
// FABRICATION SAFETY: this is a CONFIRMED proposal, not a measurement. Inserting
// the exercises as `planned` keeps 成果/履歴 truthful (workoutBurn / totalVolume /
// coachContext all exclude planned) until the user marks each done. The volume/
// burn that EVENTUALLY count come from the grounded libs, never the model.

import type { Exercise, Workout } from "./types";
import { buildLoggedExercises } from "./chatWorkoutLog";
import { toDateKey } from "./date";
import type { WorkoutPlanPayload } from "./workoutPlanProtocol";
import type {
  CalendarPlanItem,
  CalendarPlanPayload,
} from "./calendarPlanProtocol";

/**
 * The result of applying one WORKOUT_PLAN payload against the per-day store.
 * `workouts` is the next store record to persist; `exerciseIds` are the ids of the
 * planned exercises this turn inserted (recorded on the assistant chat message so a
 * later "correct" plan can resolve + replace them). `date` is the day they were
 * planned to (today). `exerciseCount` backs the "運動メニューを◯種目プランしました" chip.
 */
export interface ApplyWorkoutPlanResult {
  workouts: Record<string, Workout>;
  exerciseIds: string[];
  date: string;
  exerciseCount: number;
}

/** Stamp a grounded exercise as a not-yet-done PLAN (AIプランナー 第2陣C). */
function asPlanned(ex: Exercise): Exercise {
  return { ...ex, status: "planned" };
}

/**
 * Apply ONE WORKOUT_PLAN payload with EXPLICIT, PERSISTENT de-dupe — the plan twin
 * of applyWorkoutLog. The exercises are inserted into TODAY's workout as
 * `status:"planned"`:
 *
 *   - mode "new" (default): APPEND the planned exercises as a distinct batch.
 *   - mode "correct": REPLACE the exercises this chat last PLANNED (identified by
 *     `correctIds`, resolved by the caller from the assistant message that carried
 *     `plannedWorkout`) with the freshly proposed ones, keeping ids where possible.
 *     A "correct" whose targets are all gone (the user deleted/completed them)
 *     safely APPENDS — no ghost update.
 *
 * Plans go to TODAY only (the spec's「今日の運動メニュー」). 完了 later flips a planned
 * entry to done via the normal updateExercise on the 筋トレ page.
 *
 * Returns null when nothing groundable remains.
 */
export function applyWorkoutPlan(
  payload: WorkoutPlanPayload,
  opts: {
    workouts: Record<string, Workout>;
    /** Ids of the exercises this chat last PLANNED (for mode "correct"). */
    correctIds?: string[] | null;
    date?: string;
    now?: Date;
    makeSetId?: () => string;
  },
): ApplyWorkoutPlanResult | null {
  const date = opts.date ?? toDateKey();
  const now = opts.now ?? new Date();
  const mode = payload.mode ?? "new";

  const day: Workout = opts.workouts[date] ?? {
    date,
    exercises: [],
    updatedAt: now.toISOString(),
  };

  const correctIds = mode === "correct" && opts.correctIds ? opts.correctIds : [];
  // A "correct" only replaces in place when at least one target still exists in
  // today's workout (and is still a plan); otherwise it APPENDS (no ghost update).
  const targetsPresent =
    correctIds.length > 0 &&
    day.exercises.some((e) => correctIds.includes(e.id) && e.status === "planned");

  // Ground every proposed exercise (volume/burn from the libs, never the model),
  // reusing ids on a correct so the planned entries keep identity across the update.
  const grounded = buildLoggedExercises(
    { exercises: payload.exercises },
    opts.makeSetId,
  );
  if (grounded.length === 0) return null;
  // On a correct with present targets, reuse the first N target ids in order.
  const fresh = grounded.map((ex, i) => {
    const reuseId = targetsPresent ? correctIds[i] : undefined;
    return asPlanned(reuseId ? { ...ex, id: reuseId } : ex);
  });

  let nextExercises: Exercise[];
  if (targetsPresent) {
    // Drop the previously-planned batch, then append the regrounded one (so a
    // correction that changes the COUNT doesn't leave orphan plans).
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
 * Resolve the planned exercise ids the chat last inserted from the PERSISTED chat
 * history — the targets a "correct" plan replaces. Scans newest-first for an
 * assistant turn carrying `plannedWorkout` and returns its exerciseIds, or null
 * when none. Pure + reload-safe by construction (mirrors lastLoggedWorkoutIds).
 */
export function lastPlannedWorkoutIds(
  messages: ReadonlyArray<{
    role: string;
    plannedWorkout?: { exerciseIds: string[] } | undefined;
  }>,
): string[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.plannedWorkout?.exerciseIds?.length) {
      return m.plannedWorkout.exerciseIds;
    }
  }
  return null;
}

/** Default トレーニング event title when the coach didn't title the session. */
const DEFAULT_SESSION_TITLE = "トレーニング";

/**
 * Build a CALENDAR_PLAN payload (one トレーニング event) from a plan's session time,
 * so the EXISTING calendar path (runCalendarPlan) can reflect it onto the user's
 * Google Calendar. Returns null when the plan carries no valid start/end (the
 * calendar step is simply skipped — the plan still inserts into 筋トレ). The time is
 * the model's validated zone-aware ISO8601 (workoutPlanProtocol already dropped a
 * bad/zoneless/inverted time), so nothing is invented here. The title lists the
 * planned moves compactly as the event notes for context on the calendar.
 */
export function planToCalendarPayload(
  payload: WorkoutPlanPayload,
  opts?: { timeZone?: string; title?: string },
): CalendarPlanPayload | null {
  if (!payload.start || !payload.end) return null;
  const names = payload.exercises
    .map((e) => e.name.trim())
    .filter((n) => n.length > 0);
  const item: CalendarPlanItem = {
    type: "トレーニング",
    title: opts?.title?.trim() || DEFAULT_SESSION_TITLE,
    start: payload.start,
    end: payload.end,
    ...(names.length > 0 ? { notes: names.join("・") } : {}),
  };
  return {
    items: [item],
    ...(opts?.timeZone ? { timeZone: opts.timeZone } : {}),
  };
}

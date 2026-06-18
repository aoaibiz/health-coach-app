import { describe, it, expect } from "vitest";
import {
  applyWorkoutLog,
  buildLoggedExercise,
  buildLoggedExercises,
  lastLoggedWorkoutIds,
} from "./chatWorkoutLog";
import { totalVolume } from "./workout";
import { exerciseBurn } from "./burn";
import type { Workout } from "./types";
import type { WorkoutLogPayload } from "./workoutLogProtocol";

// These tests cover the chat→筋トレ grounding + de-dupe at the DATA layer the
// chat client drives. The NUMBERS that matter (総挙上量, 消費kcal) are computed by
// the grounded libs (workout.ts / workoutSets.ts / burn.ts), NEVER by the model.

// Deterministic set-id factory so volume/identity assertions are stable.
let n = 0;
const makeSetId = () => `set-${(n += 1)}`;

const bodyweightKg = 70;

describe("buildLoggedExercise — grounded volume + MET burn, never model numbers", () => {
  it("(d) a weighted strength exercise → exact Σ(weight×reps) volume + 推定 burn", () => {
    // ベンチ60kg×10 ×3セット. Volume = 60×10×3 = 1800kg (EXACT, from the sets).
    const ex = buildLoggedExercise(
      {
        name: "ベンチプレス",
        sets: [
          { weight: 60, reps: 10 },
          { weight: 60, reps: 10 },
          { weight: 60, reps: 10 },
        ],
      },
      { id: "ex-bench", makeSetId },
    )!;
    expect(ex.setEntries).toHaveLength(3);
    // Volume is the DIRECT measurement, computed by the grounded lib — not a model
    // number (the block carries no volume/kcal field at all).
    expect(totalVolume([ex])).toBe(1800);
    // Burn is a LABELED 推定 (MET × bodyweight × time); the method names it.
    const burn = exerciseBurn(ex, bodyweightKg);
    expect(burn.caloriesBurned).toBeGreaterThan(0);
    expect(burn.method).toContain("Compendium of Physical Activities");
  });

  it("(d) a bodyweight exercise is EXCLUDED from 総挙上量 (the 120kg-phantom fix)", () => {
    // 腹筋 ×20 ×3セット, NO weight. Even if a stray weight arrived, 腹筋 is a
    // bodyweight name → 0 volume. Reps still drive a positive MET burn.
    const ex = buildLoggedExercise(
      { name: "腹筋", sets: [{ reps: 20 }, { reps: 20 }, { reps: 20 }] },
      { id: "ex-abs", makeSetId },
    )!;
    expect(totalVolume([ex])).toBe(0); // bodyweight → excluded from volume
    expect(exerciseBurn(ex, bodyweightKg).caloriesBurned).toBeGreaterThan(0);
  });

  it("(d) a stray weight on a bodyweight name STILL contributes 0 volume", () => {
    // The model wrongly attached 120kg to 背筋 (a bodyweight move). By NAME it is
    // bodyweight, so it contributes 0 to 総挙上量 — no phantom 120kg lift.
    const ex = buildLoggedExercise(
      { name: "背筋", sets: [{ weight: 120, reps: 15 }] },
      { id: "ex-back", makeSetId },
    )!;
    expect(totalVolume([ex])).toBe(0);
  });

  it("(d) cardio → time-based (durationMin), 0 volume, positive burn", () => {
    const ex = buildLoggedExercise({ name: "ランニング", durationMin: 20 }, { id: "ex-run", makeSetId })!;
    expect(ex.durationMin).toBe(20);
    expect(ex.setEntries).toBeUndefined(); // no sets → carries no external load
    expect(totalVolume([ex])).toBe(0);
    expect(exerciseBurn(ex, bodyweightKg).caloriesBurned).toBeGreaterThan(0);
  });

  it("default weight is 0 when a set omits it (no phantom load on a weighted name)", () => {
    // ダンベルカール with reps only (user didn't say the weight) → weight 0, so it
    // contributes 0 volume rather than inventing a number.
    const ex = buildLoggedExercise(
      { name: "ダンベルカール", sets: [{ reps: 12 }] },
      { id: "ex-curl", makeSetId },
    )!;
    expect(ex.setEntries![0].weight).toBe(0);
    expect(totalVolume([ex])).toBe(0);
  });

  it("intensity scales the MET (grounded multiplier), not the volume", () => {
    const moderate = buildLoggedExercise(
      { name: "スクワット", sets: [{ weight: 80, reps: 5 }], intensity: "moderate" },
      { id: "ex-sq-m", makeSetId },
    )!;
    const hard = buildLoggedExercise(
      { name: "スクワット", sets: [{ weight: 80, reps: 5 }], intensity: "hard" },
      { id: "ex-sq-h", makeSetId },
    )!;
    // Same volume (load is identical), but a harder effort burns more (MET ×1.71).
    expect(totalVolume([moderate])).toBe(totalVolume([hard]));
    expect(exerciseBurn(hard, bodyweightKg).caloriesBurned).toBeGreaterThan(
      exerciseBurn(moderate, bodyweightKg).caloriesBurned,
    );
  });

  it("buildLoggedExercises grounds a whole payload + drops nothing groundable", () => {
    const exs = buildLoggedExercises(
      {
        exercises: [
          { name: "ベンチ", sets: [{ weight: 60, reps: 10 }] },
          { name: "ランニング", durationMin: 15 },
        ],
      },
      makeSetId,
    );
    expect(exs).toHaveLength(2);
  });
});

describe("applyWorkoutLog — explicit mode (new/correct) + history resolution", () => {
  const benchPayload: WorkoutLogPayload = {
    exercises: [{ name: "ベンチプレス", sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }] }],
  };

  it("first WORKOUT_LOG (mode new) APPENDS to today's workout and returns its ids", () => {
    const r = applyWorkoutLog(benchPayload, { workouts: {}, correctIds: null, makeSetId })!;
    expect(r).not.toBeNull();
    const day = r.workouts[r.date];
    expect(day.exercises).toHaveLength(1);
    expect(r.exerciseIds).toEqual(day.exercises.map((e) => e.id));
    expect(r.exerciseCount).toBe(1);
  });

  it("a new workout after a logged one is a SEPARATE batch (over-merge fixed)", () => {
    const first = applyWorkoutLog(benchPayload, { workouts: {}, correctIds: null, makeSetId })!;
    // "次はスクワットやった" — a genuinely new exercise. mode:new (default). History
    // has prior ids, but new must NOT replace the bench press.
    const squat: WorkoutLogPayload = {
      exercises: [{ name: "スクワット", sets: [{ weight: 80, reps: 5 }] }],
      mode: "new",
    };
    const second = applyWorkoutLog(squat, {
      workouts: first.workouts,
      correctIds: first.exerciseIds, // present, but mode:new ignores it
    })!;
    const day = second.workouts[second.date];
    expect(day.exercises).toHaveLength(2); // bench + squat, NOT an over-merge
    expect(day.exercises.map((e) => e.name)).toEqual(["ベンチプレス", "スクワット"]);
  });

  it("(e) mode correct UPDATES the logged batch in place — does not duplicate", () => {
    const first = applyWorkoutLog(benchPayload, { workouts: {}, correctIds: null, makeSetId })!;
    // History records the logged exercise ids; resolve them (reload-safe).
    const history = [
      { role: "user" as const },
      {
        role: "assistant" as const,
        loggedWorkout: { exerciseIds: first.exerciseIds, date: first.date, exerciseCount: 1 },
      },
    ];
    const resolved = lastLoggedWorkoutIds(history);
    expect(resolved).toEqual(first.exerciseIds);

    // "やっぱり10回じゃなくて12回だった" → correction (mode:correct).
    const corrected: WorkoutLogPayload = {
      exercises: [{ name: "ベンチプレス", sets: [{ weight: 60, reps: 12 }, { weight: 60, reps: 12 }] }],
      mode: "correct",
    };
    const second = applyWorkoutLog(corrected, {
      workouts: first.workouts,
      correctIds: resolved,
      makeSetId,
    })!;
    const day = second.workouts[second.date];
    expect(day.exercises).toHaveLength(1); // STILL one — updated, not duplicated
    // Volume reflects the corrected reps: 60×12×2 = 1440 (was 60×10×2 = 1200).
    expect(totalVolume(day.exercises)).toBe(1440);
  });

  it("(c) after clear() (empty history) a correct safely APPENDS — no stale clobber", () => {
    const existing = applyWorkoutLog(benchPayload, { workouts: {}, correctIds: null, makeSetId })!;
    const resolvedAfterClear = lastLoggedWorkoutIds([]); // history cleared
    expect(resolvedAfterClear).toBeNull();
    const r = applyWorkoutLog(
      { exercises: [{ name: "デッドリフト", sets: [{ weight: 100, reps: 5 }] }], mode: "correct" },
      { workouts: existing.workouts, correctIds: resolvedAfterClear, makeSetId },
    )!;
    expect(r.workouts[r.date].exercises).toHaveLength(2); // appended, not clobbered
  });

  it("a correct whose targets were deleted on /workout safely APPENDS (no ghost update)", () => {
    const first = applyWorkoutLog(benchPayload, { workouts: {}, correctIds: null, makeSetId })!;
    // User deleted the exercises on the 筋トレ page → today's workout is empty, but
    // history still points at the old ids. A correct must re-log (append).
    const emptyDay: Record<string, Workout> = {
      [first.date]: { date: first.date, exercises: [], updatedAt: new Date().toISOString() },
    };
    const r = applyWorkoutLog(
      { ...benchPayload, mode: "correct" },
      { workouts: emptyDay, correctIds: first.exerciseIds, makeSetId },
    )!;
    expect(r.workouts[r.date].exercises).toHaveLength(1);
  });

  it("a correction that REMOVES an exercise leaves no orphan from the old batch", () => {
    // Log two exercises, then correct to just one. The dropped one must be gone.
    const two: WorkoutLogPayload = {
      exercises: [
        { name: "ベンチプレス", sets: [{ weight: 60, reps: 10 }] },
        { name: "腹筋", sets: [{ reps: 20 }] },
      ],
    };
    const first = applyWorkoutLog(two, { workouts: {}, correctIds: null, makeSetId })!;
    expect(first.workouts[first.date].exercises).toHaveLength(2);
    const correctedOne: WorkoutLogPayload = {
      exercises: [{ name: "ベンチプレス", sets: [{ weight: 60, reps: 10 }] }],
      mode: "correct",
    };
    const second = applyWorkoutLog(correctedOne, {
      workouts: first.workouts,
      correctIds: first.exerciseIds,
      makeSetId,
    })!;
    expect(second.workouts[second.date].exercises).toHaveLength(1); // 腹筋 dropped
    expect(second.workouts[second.date].exercises[0].name).toBe("ベンチプレス");
  });

  it("returns null when nothing groundable remains", () => {
    expect(applyWorkoutLog({ exercises: [] }, { workouts: {}, correctIds: null })).toBeNull();
  });

  it("lastLoggedWorkoutIds returns the MOST RECENT logged ids from history", () => {
    const history = [
      { role: "assistant" as const, loggedWorkout: { exerciseIds: ["old"], date: "d", exerciseCount: 1 } },
      { role: "user" as const },
      { role: "assistant" as const, loggedWorkout: { exerciseIds: ["a", "b"], date: "d", exerciseCount: 2 } },
      { role: "assistant" as const }, // plain reply, no log
    ];
    expect(lastLoggedWorkoutIds(history)).toEqual(["a", "b"]);
    expect(lastLoggedWorkoutIds([])).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  applyWorkoutPlan,
  lastPlannedWorkoutIds,
  planToCalendarPayload,
} from "./chatWorkoutPlan";
import { exerciseCount, totalVolume, totalReps } from "./workout";
import { workoutBurn } from "./burn";
import type { Workout } from "./types";
import type { WorkoutPlanPayload } from "./workoutPlanProtocol";

// These tests cover the chat→運動メニュー提案フロー (AIプランナー 第2陣C) at the DATA
// layer: a confirmed plan is bulk-inserted as `status:"planned"`, does NOT count
// toward 成果/消費kcal until completed, and (when timed) reflects onto the calendar.

let n = 0;
const makeSetId = () => `set-${(n += 1)}`;
const bodyweightKg = 70;

const planOf = (
  exercises: WorkoutPlanPayload["exercises"],
  extra: Partial<WorkoutPlanPayload> = {},
): WorkoutPlanPayload => ({ exercises, ...extra });

describe("applyWorkoutPlan — bulk insert as PLANNED, truthful 成果", () => {
  it("inserts the proposed exercises into TODAY's workout as status:'planned'", () => {
    const payload = planOf([
      { name: "ベンチプレス", sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }] },
      { name: "腹筋", sets: [{ reps: 20 }] },
    ]);
    const result = applyWorkoutPlan(payload, { workouts: {}, date: "2026-06-26", makeSetId })!;
    expect(result).not.toBeNull();
    const day = result.workouts["2026-06-26"];
    expect(day.exercises).toHaveLength(2);
    // Every inserted exercise is a PLAN, not a done log.
    expect(day.exercises.every((e) => e.status === "planned")).toBe(true);
    expect(result.exerciseCount).toBe(2);
    expect(result.exerciseIds).toHaveLength(2);
  });

  it("PLANNED exercises do NOT count toward 成果 (種目数/総挙上量/総回数/消費kcal) until done", () => {
    const payload = planOf([
      { name: "ベンチプレス", sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }, { weight: 60, reps: 10 }] },
      { name: "腹筋", sets: [{ reps: 20 }] },
    ]);
    const day = applyWorkoutPlan(payload, { workouts: {}, date: "2026-06-26", makeSetId })!
      .workouts["2026-06-26"];

    // While planned: nothing counts (intent, not effort spent).
    expect(exerciseCount(day.exercises)).toBe(0);
    expect(totalVolume(day.exercises)).toBe(0);
    expect(totalReps(day.exercises)).toBe(0);
    expect(workoutBurn(day.exercises, bodyweightKg).totalKcal).toBe(0);

    // Marking one done (the 完了 button) makes THAT one start counting; the other
    // planned one still doesn't — proving the boundary is per-exercise.
    const completed = day.exercises.map((e) =>
      e.name === "ベンチプレス" ? { ...e, status: "done" as const } : e,
    );
    expect(exerciseCount(completed)).toBe(1); // only the done bench
    expect(totalVolume(completed)).toBe(1800); // 60×10×3, exact — bench only
    expect(workoutBurn(completed, bodyweightKg).totalKcal).toBeGreaterThan(0);
  });

  it("does not disturb an existing DONE exercise already in the day", () => {
    const existing: Workout = {
      date: "2026-06-26",
      exercises: [{ id: "done-1", name: "デッドリフト", sets: 1, reps: 5, weight: 100 }], // no status → done
      updatedAt: "2026-06-26T08:00:00.000Z",
    };
    const result = applyWorkoutPlan(planOf([{ name: "腹筋", sets: [{ reps: 20 }] }]), {
      workouts: { "2026-06-26": existing },
      date: "2026-06-26",
      makeSetId,
    })!;
    const day = result.workouts["2026-06-26"];
    expect(day.exercises).toHaveLength(2);
    const done = day.exercises.find((e) => e.id === "done-1")!;
    expect(done.status).toBeUndefined(); // untouched
    const planned = day.exercises.find((e) => e.name === "腹筋")!;
    expect(planned.status).toBe("planned");
    // The pre-existing done lift still counts; the new plan doesn't.
    expect(totalVolume(day.exercises)).toBe(500); // 100×5 from deadlift only
  });

  it("mode 'new' APPENDS a distinct plan batch (never over-merges)", () => {
    const first = applyWorkoutPlan(planOf([{ name: "腹筋", sets: [{ reps: 20 }] }]), {
      workouts: {},
      date: "2026-06-26",
      makeSetId,
    })!;
    const second = applyWorkoutPlan(planOf([{ name: "スクワット", sets: [{ reps: 15 }] }]), {
      workouts: first.workouts,
      date: "2026-06-26",
      makeSetId,
    })!;
    expect(second.workouts["2026-06-26"].exercises).toHaveLength(2);
  });

  it("mode 'correct' REPLACES the last planned batch (resolved by ids), keeps ids", () => {
    const first = applyWorkoutPlan(
      planOf([{ name: "腹筋", sets: [{ reps: 20 }] }, { name: "腕立て", sets: [{ reps: 15 }] }]),
      { workouts: {}, date: "2026-06-26", makeSetId },
    )!;
    const ids = first.exerciseIds;
    const corrected = applyWorkoutPlan(
      planOf([{ name: "腹筋", sets: [{ reps: 30 }] }], { mode: "correct" }),
      { workouts: first.workouts, correctIds: ids, date: "2026-06-26", makeSetId },
    )!;
    const day = corrected.workouts["2026-06-26"];
    // The 2-item plan is replaced by the 1-item corrected plan (no orphan).
    expect(day.exercises).toHaveLength(1);
    expect(day.exercises[0].status).toBe("planned");
    // The corrected entry keeps the first target id (identity preserved).
    expect(day.exercises[0].id).toBe(ids[0]);
  });

  it("mode 'correct' whose targets are GONE (completed/deleted) safely APPENDS", () => {
    const first = applyWorkoutPlan(planOf([{ name: "腹筋", sets: [{ reps: 20 }] }]), {
      workouts: {},
      date: "2026-06-26",
      makeSetId,
    })!;
    // Simulate the user completing the planned one (status → done).
    const day0 = first.workouts["2026-06-26"];
    const completedWorkouts = {
      "2026-06-26": {
        ...day0,
        exercises: day0.exercises.map((e) => ({ ...e, status: "done" as const })),
      },
    };
    const corrected = applyWorkoutPlan(
      planOf([{ name: "腹筋", sets: [{ reps: 30 }] }], { mode: "correct" }),
      { workouts: completedWorkouts, correctIds: first.exerciseIds, date: "2026-06-26", makeSetId },
    )!;
    // Target is no longer planned → no ghost update → it APPENDS a new plan.
    expect(corrected.workouts["2026-06-26"].exercises).toHaveLength(2);
  });

  it("returns null when nothing groundable remains", () => {
    expect(applyWorkoutPlan(planOf([]), { workouts: {}, date: "2026-06-26", makeSetId })).toBeNull();
  });
});

describe("lastPlannedWorkoutIds — resolves the correction target from history", () => {
  it("returns the newest assistant turn's plannedWorkout ids, else null", () => {
    expect(lastPlannedWorkoutIds([])).toBeNull();
    expect(
      lastPlannedWorkoutIds([
        { role: "assistant", plannedWorkout: { exerciseIds: ["a", "b"] } },
        { role: "user" },
        { role: "assistant", plannedWorkout: { exerciseIds: ["c"] } },
      ]),
    ).toEqual(["c"]);
    expect(lastPlannedWorkoutIds([{ role: "assistant" }])).toBeNull();
  });
});

describe("planToCalendarPayload — reflects the session time onto the calendar", () => {
  it("builds ONE トレーニング event from a timed plan (names → notes)", () => {
    const payload = planOf(
      [{ name: "ベンチプレス", sets: [{ weight: 60, reps: 10 }] }, { name: "腹筋", sets: [{ reps: 20 }] }],
      { start: "2026-06-26T18:00:00+09:00", end: "2026-06-26T19:00:00+09:00" },
    );
    const cal = planToCalendarPayload(payload, { timeZone: "Asia/Tokyo" })!;
    expect(cal).not.toBeNull();
    expect(cal.items).toHaveLength(1);
    expect(cal.items[0].type).toBe("トレーニング");
    expect(cal.items[0].start).toBe("2026-06-26T18:00:00+09:00");
    expect(cal.items[0].end).toBe("2026-06-26T19:00:00+09:00");
    expect(cal.items[0].notes).toBe("ベンチプレス・腹筋");
    expect(cal.timeZone).toBe("Asia/Tokyo");
  });

  it("returns null when the plan carries no session time (calendar skipped)", () => {
    const payload = planOf([{ name: "腹筋", sets: [{ reps: 20 }] }]);
    expect(planToCalendarPayload(payload)).toBeNull();
  });
});

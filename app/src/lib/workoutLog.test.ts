import { describe, it, expect } from "vitest";
import {
  exerciseVolume,
  makeSet,
  summarizeSets,
  syncLegacyFields,
} from "./workoutSets";
import { workoutBurn, exerciseBurn, isWeightedExercise } from "./burn";
import { totalVolume, totalReps, weightedExerciseCount } from "./workout";
import type { Exercise, SetEntry } from "./types";

// These tests cover the WORKOUT "log → collapse → re-expand → edit/save/remove"
// flow at the DATA layer that the page (workout/page.tsx) + hook (useWorkout)
// drive, exactly mirroring the meal page's add/update/remove over a list, and
// proving the day's totals (SummaryPanel / dashboard) reflect logged exercises.
// The collapsed ExerciseCard's compact line comes from summarizeSets().

let idCounter = 0;
const id = () => `s${(idCounter += 1)}`;

function exWithSets(
  name: string,
  sets: Array<{ weight: number; reps: number }>,
  extra: Partial<Exercise> = {},
): Exercise {
  const setEntries: SetEntry[] = sets.map((s) => makeSet(id(), s.weight, s.reps));
  return syncLegacyFields(
    { id: id(), name, sets: 0, reps: 0, weight: 0, durationMin: 0, ...extra },
    setEntries,
  );
}

// The page's add/update/remove (mirrors useMeals + meal/page.tsx handleSave).
const addExercise = (list: Exercise[], ex: Exercise): Exercise[] => [...list, ex];
const updateExercise = (list: Exercise[], id: string, next: Exercise): Exercise[] =>
  list.map((e) => (e.id === id ? next : e));
const removeExercise = (list: Exercise[], id: string): Exercise[] =>
  list.filter((e) => e.id !== id);

describe("summarizeSets — the collapsed ExerciseCard's compact line", () => {
  it("uniform weighted sets → '60kg×10 ×3セット'", () => {
    const sets = [makeSet(id(), 60, 10), makeSet(id(), 60, 10), makeSet(id(), 60, 10)];
    expect(summarizeSets(sets, false)).toBe("60kg×10 ×3セット");
  });

  it("varying sets list each one (nothing lost)", () => {
    const sets = [makeSet(id(), 60, 10), makeSet(id(), 70, 8), makeSet(id(), 80, 6)];
    expect(summarizeSets(sets, false)).toBe("60kg×10 / 70kg×8 / 80kg×6");
  });

  it("bodyweight move shows no phantom kg (reps only)", () => {
    const sets = [makeSet(id(), 0, 20), makeSet(id(), 0, 20), makeSet(id(), 0, 20)];
    expect(summarizeSets(sets, true)).toBe("×20 ×3セット");
  });

  it("varying bodyweight reps list each one", () => {
    const sets = [makeSet(id(), 0, 20), makeSet(id(), 0, 30)];
    expect(summarizeSets(sets, true)).toBe("×20 / ×30");
  });

  it("a 0kg set on a weighted move prints no phantom weight", () => {
    expect(summarizeSets([makeSet(id(), 0, 12)], false)).toBe("×12 ×1セット");
  });

  it("no sets → empty string (card shows its 0 state)", () => {
    expect(summarizeSets([], false)).toBe("");
  });
});

describe("log → collapse: logging an exercise updates the day total", () => {
  it("adding a weighted lift raises the day's volume + reps", () => {
    let day: Exercise[] = [];
    const bench = exWithSets("ベンチプレス", [
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
    ]);
    day = addExercise(day, bench);
    expect(totalVolume(day)).toBe(1800);
    expect(totalReps(day)).toBe(30);
    expect(weightedExerciseCount(day)).toBe(1);
    // The collapsed card line + burn the SummaryPanel would show.
    expect(summarizeSets(bench.setEntries!, !isWeightedExercise(bench))).toBe(
      "60kg×10 ×3セット",
    );
    expect(workoutBurn(day, 80).totalKcal).toBe(7);
  });
});

describe("re-expand → edit → save updates the logged entry + totals", () => {
  it("editing a logged exercise (heavier) raises volume; id is preserved", () => {
    const bench = exWithSets("ベンチプレス", [{ weight: 60, reps: 10 }]);
    let day = addExercise([], bench);
    expect(totalVolume(day)).toBe(600);

    // Re-open the card → editor returns the same exercise with edited sets.
    const edited = syncLegacyFields(bench, [makeSet(id(), 80, 10)]);
    day = updateExercise(day, bench.id, edited);

    expect(day).toHaveLength(1); // updated in place, not appended
    expect(day[0].id).toBe(bench.id);
    expect(totalVolume(day)).toBe(800);
  });

  it("editing a bodyweight move keeps it out of 総挙上量 (0 volume)", () => {
    const back = exWithSets("背筋", [{ weight: 0, reps: 15 }]);
    let day = addExercise([], back);
    // Edit: add a set + try to set a stray weight — must stay 0 volume.
    const edited = syncLegacyFields(back, [
      makeSet(id(), 0, 15),
      makeSet(id(), 99, 15), // stray weight on a known bodyweight move
    ]);
    day = updateExercise(day, back.id, edited);
    expect(isWeightedExercise(day[0])).toBe(false);
    expect(totalVolume(day)).toBe(0);
    expect(weightedExerciseCount(day)).toBe(0);
    expect(totalReps(day)).toBe(30);
  });
});

describe("removing a logged exercise drops it from the day total", () => {
  it("multiple logged exercises + the day total, then remove one", () => {
    const back = exWithSets("背筋", [{ weight: 0, reps: 20 }]); // bodyweight → 0 vol
    const bench = exWithSets("ベンチプレス", [
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
    ]); // 1200
    const abs = exWithSets("腹筋", [{ weight: 0, reps: 25 }]); // bodyweight → 0 vol

    let day = addExercise(addExercise(addExercise([], back), bench), abs);
    expect(day).toHaveLength(3);
    expect(totalVolume(day)).toBe(1200);
    expect(weightedExerciseCount(day)).toBe(1);
    expect(totalReps(day)).toBe(20 + 20 + 25);

    // Remove the bench → its volume leaves the day total.
    day = removeExercise(day, bench.id);
    expect(day).toHaveLength(2);
    expect(totalVolume(day)).toBe(0);
    expect(weightedExerciseCount(day)).toBe(0);
    expect(totalReps(day)).toBe(20 + 25);
  });
});

describe("bodyweight card: shows 自重 (no weight) and 0 volume", () => {
  it("a 自重 move contributes 0 to 総挙上量 and its line has no kg", () => {
    const pushups = exWithSets("腕立て", [
      { weight: 0, reps: 20 },
      { weight: 0, reps: 20 },
    ]);
    const day = addExercise([], pushups);
    expect(isWeightedExercise(pushups)).toBe(false); // → card renders 自重 chip
    expect(exerciseVolume(pushups.setEntries!)).toBe(0);
    expect(totalVolume(day)).toBe(0);
    // The card's compact line uses bodyweight formatting (no phantom kg).
    expect(summarizeSets(pushups.setEntries!, true)).toBe("×20 ×2セット");
    // Burn is still a meaningful labeled estimate even with 0 volume.
    expect(exerciseBurn(pushups, 80).caloriesBurned).toBeGreaterThan(0);
  });
});

describe("edge: logging an exercise with 0 sets-worth of reps", () => {
  it("0 reps → 0 volume + 0 reps (no phantom load), burn stays finite", () => {
    const ex = exWithSets("ベンチプレス", [{ weight: 60, reps: 0 }]);
    const day = addExercise([], ex);
    // No reps logged → no volume, no reps. The card shows no kg / no 回 chip.
    expect(totalVolume(day)).toBe(0);
    expect(totalReps(day)).toBe(0);
    // Burn is a LABELED estimate: with no rep-derived time it falls back to the
    // default-duration estimate (MET 3.5 × 80kg × 20min/60 = 93), never NaN.
    // This is existing grounded behavior, not a fabricated authoritative number.
    const total = workoutBurn(day, 80).totalKcal;
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBe(93);
  });
});

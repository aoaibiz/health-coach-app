import { describe, it, expect } from "vitest";
import {
  totalVolume,
  exerciseCount,
  weightedExerciseCount,
  totalReps,
  formatNumber,
  stepValue,
  displayStepValue,
} from "./workout";
import type { Exercise } from "./types";

function ex(partial: Partial<Exercise>): Exercise {
  return {
    id: Math.random().toString(36).slice(2),
    name: "",
    sets: 3,
    reps: 10,
    // Default weight 0 mirrors addExercise() in workout/page.tsx — a blank row
    // must carry no phantom load.
    weight: 0,
    durationMin: 20,
    ...partial,
  };
}

describe("totalVolume — blank-name rows excluded (no phantom volume)", () => {
  it("a single just-added blank row contributes 0", () => {
    // Regression: addExercise() seeds placeholder sets/reps. With no name
    // entered the summary must show 0kg, never a phantom total.
    const exercises = [ex({ name: "" })];
    expect(totalVolume(exercises)).toBe(0);
    expect(exerciseCount(exercises)).toBe(0);
  });

  it("default seeded weight is 0 (the phantom-volume root cause is gone)", () => {
    // A freshly-added row with the seeded default (weight unset → 0) adds no
    // volume even once it has a name, until the user dials in real load.
    expect(ex({}).weight).toBe(0);
  });

  it("whitespace-only name is treated as blank", () => {
    expect(totalVolume([ex({ name: "   " })])).toBe(0);
  });

  it("counts only named rows; blanks add nothing to the total", () => {
    const exercises = [
      ex({ name: "ベンチプレス", sets: 3, reps: 10, weight: 60 }), // 1800
      ex({ name: "", sets: 3, reps: 10, weight: 20 }), // blank → 0
      ex({ name: "スクワット", sets: 5, reps: 5, weight: 100 }), // 2500
    ];
    expect(totalVolume(exercises)).toBe(1800 + 2500);
    expect(exerciseCount(exercises)).toBe(2);
  });

  it("empty list → 0", () => {
    expect(totalVolume([])).toBe(0);
    expect(exerciseCount([])).toBe(0);
  });

  it("bodyweight (0kg) named exercise still contributes 0 volume but counts", () => {
    const exercises = [ex({ name: "腕立て伏せ", sets: 3, reps: 20, weight: 0 })];
    expect(totalVolume(exercises)).toBe(0);
    expect(exerciseCount(exercises)).toBe(1);
  });
});

describe("totalVolume — bodyweight moves never produce phantom 総挙上量", () => {
  it("背筋 alone → 総挙上量 0, even with a stray weight value (the reported bug)", () => {
    // The owner saw "120kg 総挙上量" for 背筋 because a default weight was being
    // multiplied in. 背筋 is bodyweight → it must contribute 0 to volume.
    const exercises = [ex({ name: "背筋", sets: 3, reps: 20, weight: 20 })];
    expect(totalVolume(exercises)).toBe(0);
    expect(weightedExerciseCount(exercises)).toBe(0);
  });

  it("腹筋 alone → 総挙上量 0", () => {
    const exercises = [ex({ name: "腹筋", sets: 3, reps: 30, weight: 15 })];
    expect(totalVolume(exercises)).toBe(0);
    expect(weightedExerciseCount(exercises)).toBe(0);
  });

  it("ベンチプレス 60kg × 3 × 10 → 1800", () => {
    const exercises = [ex({ name: "ベンチプレス", sets: 3, reps: 10, weight: 60 })];
    expect(totalVolume(exercises)).toBe(1800);
    expect(weightedExerciseCount(exercises)).toBe(1);
  });

  it("mixed day: only the weighted lift counts toward 総挙上量", () => {
    const exercises = [
      ex({ name: "背筋", sets: 3, reps: 20, weight: 20 }), // bodyweight → 0
      ex({ name: "ベンチプレス", sets: 3, reps: 10, weight: 60 }), // 1800
      ex({ name: "腹筋", sets: 4, reps: 25, weight: 0 }), // bodyweight → 0
    ];
    expect(totalVolume(exercises)).toBe(1800);
    expect(weightedExerciseCount(exercises)).toBe(1);
    expect(exerciseCount(exercises)).toBe(3);
  });

  it("ambiguous スクワット with weight > 0 counts; bare スクワット does not", () => {
    expect(totalVolume([ex({ name: "スクワット", sets: 5, reps: 5, weight: 100 })])).toBe(2500);
    expect(totalVolume([ex({ name: "スクワット", sets: 5, reps: 5, weight: 0 })])).toBe(0);
  });
});

describe("weightedExerciseCount — drives 総挙上量 visibility", () => {
  it("0 for a bodyweight-only day", () => {
    const exercises = [
      ex({ name: "背筋", sets: 3, reps: 20, weight: 0 }),
      ex({ name: "腹筋", sets: 3, reps: 30, weight: 0 }),
    ];
    expect(weightedExerciseCount(exercises)).toBe(0);
  });

  it("counts only weighted moves with weight > 0", () => {
    const exercises = [
      ex({ name: "ベンチプレス", weight: 60 }), // counts
      ex({ name: "ベンチプレス", weight: 0 }), // weighted name but 0 load → excluded
      ex({ name: "腕立て伏せ", weight: 0 }), // bodyweight → excluded
      ex({ name: "スクワット", weight: 80 }), // ambiguous + load → counts
    ];
    expect(weightedExerciseCount(exercises)).toBe(2);
  });
});

describe("totalReps — bodyweight effort metric", () => {
  it("sums sets × reps across named exercises", () => {
    const exercises = [
      ex({ name: "腹筋", sets: 3, reps: 20 }), // 60
      ex({ name: "背筋", sets: 4, reps: 15 }), // 60
      ex({ name: "", sets: 3, reps: 10 }), // blank → excluded
    ];
    expect(totalReps(exercises)).toBe(120);
  });

  it("empty / blank → 0", () => {
    expect(totalReps([])).toBe(0);
    expect(totalReps([ex({ name: "" })])).toBe(0);
  });
});

describe("stepValue / displayStepValue — stepper shows + reflects the value", () => {
  it("increments and decrements, clamping at min", () => {
    expect(stepValue(3, 1)).toBe(4); // tap +
    expect(stepValue(3, -1)).toBe(2); // tap −
    expect(stepValue(0, -1)).toBe(0); // clamp at 0
  });

  it("supports fractional steps (2.5kg) without float drift", () => {
    expect(stepValue(20, 2.5)).toBe(22.5);
    expect(stepValue(22.5, 2.5)).toBe(25);
    expect(stepValue(2.5, -2.5)).toBe(0);
  });

  it("repeated taps accumulate — the displayed value reflects each tap", () => {
    let v = 3;
    v = stepValue(v, 1); // 4
    v = stepValue(v, 1); // 5
    v = stepValue(v, 1); // 6
    expect(v).toBe(6);
    // displayStepValue is what the UI renders between − and +; it equals v.
    expect(displayStepValue(v)).toBe(6);
  });

  it("displayStepValue never yields NaN/undefined (falls back to min)", () => {
    expect(displayStepValue(NaN)).toBe(0);
    expect(displayStepValue(Number.POSITIVE_INFINITY)).toBe(0);
    expect(displayStepValue(NaN, 1)).toBe(1);
    expect(displayStepValue(7)).toBe(7);
  });
});

describe("formatNumber", () => {
  it("rounds and adds thousands separators", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1234.6)).toBe("1,235");
  });
});

describe("planned exclusion (AIプランナー 第2陣C) — a plan is intent, not 成果", () => {
  // A weighted lift logged DONE vs the SAME lift left PLANNED. Only the done one
  // counts toward 種目数/総挙上量/総回数; absent status = done (back-compat).
  const doneLift = ex({ name: "ベンチプレス", sets: 1, reps: 30, weight: 60 }); // vol 1800
  const plannedLift = ex({
    name: "デッドリフト",
    sets: 1,
    reps: 5,
    weight: 100,
    status: "planned",
  });

  it("totalVolume / totalReps / exerciseCount count DONE only", () => {
    const mixed = [doneLift, plannedLift];
    // Done bench: 1×30×60 = 1800. Planned deadlift excluded.
    expect(totalVolume(mixed)).toBe(1800);
    expect(totalReps(mixed)).toBe(30); // 30 done reps; planned 5 excluded
    expect(exerciseCount(mixed)).toBe(1); // only the done one is a 種目
    expect(weightedExerciseCount(mixed)).toBe(1);
  });

  it("absent status behaves exactly like before (done) — back-compat", () => {
    expect(totalVolume([doneLift])).toBe(1800);
    expect(exerciseCount([doneLift])).toBe(1);
  });

  it("a planned-only day shows zero 成果 until completed", () => {
    expect(exerciseCount([plannedLift])).toBe(0);
    expect(totalVolume([plannedLift])).toBe(0);
    expect(totalReps([plannedLift])).toBe(0);
    // Flipping it done makes it count.
    const done = { ...plannedLift, status: "done" as const };
    expect(exerciseCount([done])).toBe(1);
    expect(totalVolume([done])).toBe(500); // 100×5
  });
});

import { describe, it, expect } from "vitest";
import {
  clampReps,
  clampWeight,
  exerciseTotalReps,
  exerciseVolume,
  makeSet,
  setSetReps,
  setSetWeight,
  setsFor,
  setsRepsCaption,
  setVolume,
  syncLegacyFields,
} from "./workoutSets";
import {
  exerciseBurn,
  intensityMultiplier,
  INTENSITY_MET_MULTIPLIER,
  isWeightedExercise,
} from "./burn";
import { totalVolume, totalReps, weightedExerciseCount } from "./workout";
import type { Exercise, SetEntry } from "./types";

// Per-set burn = MET × bodyweight(kg) × time, where time for rep-based strength
// = Σreps × SECONDS_PER_REP / 60 (3s/rep). MET values are from the 2011
// Compendium of Physical Activities; intensity scales the MET (02054 moderate
// 3.5 → 02050 vigorous 6.0 ≈ 1.71×). Nothing is fabricated.

let idCounter = 0;
function id(): string {
  idCounter += 1;
  return `s${idCounter}`;
}

/** Build an exercise with explicit per-set entries. */
function exWithSets(
  name: string,
  sets: Array<{ weight: number; reps: number }>,
  extra: Partial<Exercise> = {},
): Exercise {
  const setEntries: SetEntry[] = sets.map((s) => makeSet(id(), s.weight, s.reps));
  return syncLegacyFields(
    { id: "ex", name, sets: 0, reps: 0, weight: 0, durationMin: 0, ...extra },
    setEntries,
  );
}

describe("clamp helpers — sane, non-negative, no float drift", () => {
  it("clampWeight floors negatives/NaN at 0 and rounds to 0.25kg", () => {
    expect(clampWeight(-5)).toBe(0);
    expect(clampWeight(NaN)).toBe(0);
    expect(clampWeight(62.5)).toBe(62.5);
    expect(clampWeight(2.5 * 3)).toBe(7.5); // exact, no drift
    expect(clampWeight(1e9)).toBe(1000); // capped
  });

  it("clampReps floors negatives/NaN at 0 and rounds to an integer", () => {
    expect(clampReps(-3)).toBe(0);
    expect(clampReps(NaN)).toBe(0);
    expect(clampReps(10.4)).toBe(10);
    expect(clampReps(99999)).toBe(9999); // capped
  });
});

describe("setVolume / exerciseVolume — Σ weight × reps (direct measurement)", () => {
  it("a set's volume is weight × reps", () => {
    expect(setVolume(makeSet(id(), 60, 10))).toBe(600);
  });

  it("a 0-weight (bodyweight) set contributes 0 volume", () => {
    expect(setVolume(makeSet(id(), 0, 20))).toBe(0);
  });

  it("exerciseVolume sums each set exactly (no scalar approximation)", () => {
    // A pyramid: 60×10 + 70×8 + 80×6 = 600 + 560 + 480 = 1640.
    const sets = [makeSet(id(), 60, 10), makeSet(id(), 70, 8), makeSet(id(), 80, 6)];
    expect(exerciseVolume(sets)).toBe(1640);
  });

  it("exerciseTotalReps sums reps across sets", () => {
    const sets = [makeSet(id(), 60, 10), makeSet(id(), 70, 8), makeSet(id(), 80, 6)];
    expect(exerciseTotalReps(sets)).toBe(24);
  });
});

describe("syncLegacyFields — scalar sets/reps/weight stay consistent", () => {
  it("legacy fields reproduce the exact per-set volume via sets×reps×weight", () => {
    const ex = exWithSets("ベンチプレス", [
      { weight: 60, reps: 10 },
      { weight: 70, reps: 8 },
      { weight: 80, reps: 6 },
    ]);
    // sets=1, reps=Σreps=24, weight=volume/Σreps. The product reproduces volume.
    expect(ex.sets).toBe(1);
    expect(ex.reps).toBe(24);
    expect(ex.sets * ex.reps * ex.weight).toBeCloseTo(1640, 6);
  });

  it("an all-bodyweight (0kg) exercise syncs to weight 0 — no phantom load", () => {
    const ex = exWithSets("腹筋", [
      { weight: 0, reps: 20 },
      { weight: 0, reps: 20 },
    ]);
    expect(ex.weight).toBe(0);
    expect(ex.reps).toBe(40);
  });

  it("0 total reps → weight 0 (no division-by-zero, no NaN)", () => {
    const ex = exWithSets("ベンチプレス", [{ weight: 60, reps: 0 }]);
    expect(Number.isFinite(ex.weight)).toBe(true);
    expect(ex.weight).toBe(0);
    expect(ex.reps).toBe(0);
  });
});

describe("totalVolume / totalReps — per-set data is used when present", () => {
  it("totalVolume uses the EXACT Σ weight×reps for per-set exercises", () => {
    const ex = exWithSets("ベンチプレス", [
      { weight: 60, reps: 10 },
      { weight: 70, reps: 8 },
      { weight: 80, reps: 6 },
    ]);
    expect(totalVolume([ex])).toBe(1640);
  });

  it("totalVolume still works for legacy (no setEntries) exercises", () => {
    const legacy: Exercise = {
      id: "l",
      name: "ベンチプレス",
      sets: 3,
      reps: 10,
      weight: 60,
    };
    expect(totalVolume([legacy])).toBe(1800); // 3×10×60, unchanged
  });

  it("bodyweight per-set exercise stays OUT of 総挙上量 (the 120kg bug)", () => {
    // 背筋 with stray per-set weights must contribute 0 to volume.
    const ex = exWithSets("背筋", [
      { weight: 20, reps: 15 },
      { weight: 20, reps: 15 },
    ]);
    expect(totalVolume([ex])).toBe(0);
    expect(weightedExerciseCount([ex])).toBe(0);
  });

  it("totalReps sums Σreps over sets for per-set exercises", () => {
    const ex = exWithSets("腹筋", [
      { weight: 0, reps: 20 },
      { weight: 0, reps: 30 },
    ]);
    expect(totalReps([ex])).toBe(50);
  });

  it("mixed day: only weighted per-set lifts count toward 総挙上量", () => {
    const back = exWithSets("背筋", [{ weight: 0, reps: 20 }]); // bodyweight → 0
    const bench = exWithSets("ベンチプレス", [
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
    ]); // 1200
    const abs = exWithSets("腹筋", [{ weight: 0, reps: 25 }]); // bodyweight → 0
    expect(totalVolume([back, bench, abs])).toBe(1200);
    expect(weightedExerciseCount([back, bench, abs])).toBe(1);
  });
});

describe("add / remove set updates the totals live", () => {
  it("adding a set raises volume and reps", () => {
    const before = exWithSets("ベンチプレス", [{ weight: 60, reps: 10 }]);
    const after = syncLegacyFields(before, [
      ...(before.setEntries ?? []),
      makeSet(id(), 60, 10),
    ]);
    expect(totalVolume([before])).toBe(600);
    expect(totalVolume([after])).toBe(1200); // 2 sets now
    expect(totalReps([after])).toBe(20);
  });

  it("removing a set lowers volume and reps", () => {
    const three = exWithSets("ベンチプレス", [
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
    ]);
    const sets = three.setEntries ?? [];
    const two = syncLegacyFields(three, sets.slice(0, 2));
    expect(totalVolume([three])).toBe(1800);
    expect(totalVolume([two])).toBe(1200);
    expect(totalReps([two])).toBe(20);
  });
});

describe("setSetWeight / setSetReps — edit a single set (no mutation)", () => {
  it("changing one set's weight updates only that set's volume", () => {
    const set = makeSet(id(), 60, 10);
    const heavier = setSetWeight(set, 80);
    expect(set.weight).toBe(60); // original untouched
    expect(heavier.weight).toBe(80);
    expect(setVolume(heavier)).toBe(800);
  });

  it("changing reps recomputes volume; 0 reps → 0 volume (safe)", () => {
    const set = makeSet(id(), 60, 10);
    expect(setVolume(setSetReps(set, 12))).toBe(720);
    expect(setVolume(setSetReps(set, 0))).toBe(0);
  });
});

describe("per-set weight×reps → calorie burn (rep-derived time)", () => {
  it("ベンチ 60kg×10 ×3sets, 80kg body, moderate → 7 kcal (worked example)", () => {
    // Σreps = 30 → time = 30×3/60 = 1.5min → 0.025h. MET 3.5×1.0 = 3.5.
    // 3.5 × 80 × 0.025 = 7.0 → 7 kcal. Volume = 1800kg (3×10×60).
    const ex = exWithSets("ベンチプレス", [
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
    ]);
    const r = exerciseBurn(ex, 80);
    expect(r.met).toBe(3.5);
    expect(r.caloriesBurned).toBe(7);
    expect(totalVolume([ex])).toBe(1800);
  });

  it("more reps per set → more burn (reps drive the rep-derived time)", () => {
    const few = exerciseBurn(exWithSets("ベンチプレス", [{ weight: 60, reps: 5 }]), 80);
    const many = exerciseBurn(exWithSets("ベンチプレス", [{ weight: 60, reps: 20 }]), 80);
    expect(many.caloriesBurned).toBeGreaterThan(few.caloriesBurned);
    expect(many.method).toContain("回数から推定");
  });

  it("adding a set increases the burn (more total reps)", () => {
    const one = exWithSets("ベンチプレス", [{ weight: 60, reps: 10 }]);
    const two = syncLegacyFields(one, [...(one.setEntries ?? []), makeSet(id(), 60, 10)]);
    expect(exerciseBurn(two, 80).caloriesBurned).toBeGreaterThan(
      exerciseBurn(one, 80).caloriesBurned,
    );
  });
});

describe("intensity scaling — grounded in the Compendium's effort-level codes", () => {
  it("multipliers: light 0.8×, moderate 1.0×, hard ≈ 6.0/3.5", () => {
    expect(INTENSITY_MET_MULTIPLIER.light).toBe(0.8);
    expect(INTENSITY_MET_MULTIPLIER.moderate).toBe(1.0);
    expect(INTENSITY_MET_MULTIPLIER.hard).toBeCloseTo(6.0 / 3.5, 6); // ≈1.714
    expect(intensityMultiplier(undefined)).toBe(1.0); // absent → moderate
  });

  it("hard scales the MET (and thus kcal) above moderate by 6.0/3.5", () => {
    const sets = [
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
      { weight: 60, reps: 10 },
    ];
    const moderate = exerciseBurn(exWithSets("ベンチプレス", sets, { intensity: "moderate" }), 80);
    const hard = exerciseBurn(exWithSets("ベンチプレス", sets, { intensity: "hard" }), 80);
    // MET: 3.5 → 3.5×(6/3.5)=6.0. kcal: 7 → 6.0×80×0.025 = 12.
    expect(moderate.met).toBe(3.5);
    expect(hard.met).toBe(6.0);
    expect(moderate.caloriesBurned).toBe(7);
    expect(hard.caloriesBurned).toBe(12);
    expect(hard.method).toContain("きつい");
  });

  it("light scales the MET below moderate (0.8×) and is labeled", () => {
    const sets = [
      { weight: 0, reps: 50 },
      { weight: 0, reps: 50 },
    ];
    const light = exerciseBurn(exWithSets("腹筋", sets, { intensity: "light" }), 80);
    // 腹筋 MET 3.8 × 0.8 = 3.04. Σreps=100 → 5min → 0.0833h. 3.04×80×0.0833≈20.27→20.
    expect(light.met).toBe(3.04);
    expect(light.caloriesBurned).toBe(20);
    expect(light.method).toContain("軽い");
  });

  it("moderate (default) leaves the method note byte-identical (no effort tag)", () => {
    const r = exerciseBurn(exWithSets("ベンチプレス", [{ weight: 60, reps: 10 }]), 80);
    expect(r.method).not.toContain("強度");
  });
});

describe("cardio stays time-based — per-set reps never change a cardio burn", () => {
  it("running burn ignores any per-set entries; uses logged minutes", () => {
    const a = exWithSets("ランニング", [{ weight: 0, reps: 10 }], { durationMin: 30 });
    const b = exWithSets("ランニング", [
      { weight: 0, reps: 99 },
      { weight: 0, reps: 99 },
    ], { durationMin: 30 });
    // 9.8 × 70 × 0.5 = 343 for both — reps don't enter the cardio calc.
    expect(exerciseBurn(a, 70).caloriesBurned).toBe(343);
    expect(exerciseBurn(b, 70).caloriesBurned).toBe(343);
  });
});

describe("classifier — per-set data drives ambiguous weighted/bodyweight", () => {
  it("ambiguous スクワット with a weighted set → weighted; all-0 sets → bodyweight", () => {
    const loaded = exWithSets("スクワット", [{ weight: 80, reps: 5 }]);
    const air = exWithSets("スクワット", [{ weight: 0, reps: 15 }]);
    expect(isWeightedExercise(loaded)).toBe(true);
    expect(isWeightedExercise(air)).toBe(false);
    expect(totalVolume([loaded])).toBe(400);
    expect(totalVolume([air])).toBe(0);
  });

  it("known bodyweight 背筋 is never weighted, even with a stray per-set weight", () => {
    const ex = exWithSets("背筋", [{ weight: 99, reps: 10 }]);
    expect(isWeightedExercise(ex)).toBe(false);
    expect(totalVolume([ex])).toBe(0);
  });
});

describe("setsFor — uniform per-set view (own array, else expanded legacy)", () => {
  it("returns the exercise's own setEntries when present", () => {
    const ex = exWithSets("ベンチプレス", [
      { weight: 60, reps: 10 },
      { weight: 70, reps: 8 },
    ]);
    expect(setsFor(ex, id)).toHaveLength(2);
  });

  it("expands a legacy exercise into N identical editable sets", () => {
    const legacy: Exercise = { id: "l", name: "ベンチプレス", sets: 3, reps: 10, weight: 60 };
    const sets = setsFor(legacy, id);
    expect(sets).toHaveLength(3);
    expect(sets[0].weight).toBe(60);
    expect(sets[0].reps).toBe(10);
  });

  it("a single-set exercise expands to exactly one set", () => {
    const legacy: Exercise = { id: "l", name: "ベンチプレス", sets: 1, reps: 5, weight: 100 };
    expect(setsFor(legacy, id)).toHaveLength(1);
  });
});

describe("setsRepsCaption — plain「何セット×何回」for the figure guide", () => {
  it("uniform reps → 'Nセット × M回' (no weight)", () => {
    const sets = [makeSet(id(), 0, 10), makeSet(id(), 0, 10), makeSet(id(), 0, 10)];
    expect(setsRepsCaption(sets)).toBe("3セット × 10回");
  });

  it("omits weight even on a weighted move (kg lives in the summary line)", () => {
    const sets = [makeSet(id(), 60, 8), makeSet(id(), 60, 8)];
    expect(setsRepsCaption(sets)).toBe("2セット × 8回");
  });

  it("varying reps → '全Nセット（合計M回）' so nothing is lost", () => {
    const sets = [makeSet(id(), 0, 20), makeSet(id(), 0, 15), makeSet(id(), 0, 20)];
    expect(setsRepsCaption(sets)).toBe("全3セット（合計55回）");
  });

  it("a single set reads as '1セット × M回'", () => {
    expect(setsRepsCaption([makeSet(id(), 0, 12)])).toBe("1セット × 12回");
  });

  it("no usable reps (all 0) or empty → '' (caller hides the caption)", () => {
    expect(setsRepsCaption([])).toBe("");
    expect(setsRepsCaption([makeSet(id(), 0, 0), makeSet(id(), 0, 0)])).toBe("");
  });
});

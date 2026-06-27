import { describe, it, expect } from "vitest";
import {
  metForExercise,
  exerciseBurn,
  workoutBurn,
  isBodyweightName,
  isWeightedName,
  isWeightedExercise,
  isCardioName,
  isRepBasedStrength,
  DEFAULT_DURATION_MIN,
  DEFAULT_MET,
  SECONDS_PER_REP,
} from "./burn";
import type { Exercise } from "./types";

/**
 * Burn = MET × bodyweight(kg) × duration(hours).
 * MET values are from the 2011 Compendium of Physical Activities.
 */

function ex(overrides: Partial<Exercise> = {}): Exercise {
  return { id: "x", name: "ベンチプレス", sets: 3, reps: 10, weight: 60, ...overrides };
}

describe("metForExercise — name → MET lookup", () => {
  const cases: Array<{ name: string; met: number }> = [
    { name: "ベンチプレス", met: 3.5 }, // general resistance training
    { name: "bench press", met: 3.5 },
    { name: "スクワット", met: 5.0 }, // squats (resistance)
    { name: "デッドリフト", met: 6.0 }, // heavy/powerlifting
    { name: "ランニング", met: 9.8 }, // running
    { name: "ジョギング", met: 7.0 }, // jogging
    { name: "ウォーキング", met: 3.5 }, // walking
    { name: "腕立て伏せ", met: 8.0 }, // calisthenics, vigorous
    { name: "プランク", met: 3.8 }, // calisthenics, light/moderate
    { name: "サイクリング", met: 7.5 }, // cycling
  ];

  for (const c of cases) {
    it(`"${c.name}" → ${c.met} MET`, () => {
      expect(metForExercise(c.name)).toBe(c.met);
    });
  }

  it("matching is case-insensitive and trims whitespace", () => {
    expect(metForExercise("  BENCH PRESS  ")).toBe(3.5);
  });

  it("unknown exercise falls back to the default MET", () => {
    expect(metForExercise("謎のトレーニング")).toBe(DEFAULT_MET);
    expect(metForExercise("")).toBe(DEFAULT_MET);
    expect(DEFAULT_MET).toBe(3.5);
  });
});

describe("exerciseBurn — MET × kg × hours", () => {
  it("3.5 MET, 80kg, 30 min → 140 kcal", () => {
    // 3.5 × 80 × 0.5 = 140
    const r = exerciseBurn(ex({ name: "ベンチプレス", durationMin: 30 }), 80);
    expect(r.met).toBe(3.5);
    expect(r.caloriesBurned).toBe(140);
    expect(r.method).toContain("MET");
  });

  it("running 9.8 MET, 70kg, 45 min → 515 kcal", () => {
    // 9.8 × 70 × 0.75 = 514.5 → 515 (round half up)
    const r = exerciseBurn(ex({ name: "ランニング", durationMin: 45 }), 70);
    expect(r.caloriesBurned).toBe(515);
  });

  it("falls back to the default duration for cardio with no time logged", () => {
    // Cardio (ウォーキング) stays time-based: with no logged minutes it uses the
    // default duration, NOT a rep estimate. 3.5 × 80 × (20/60) = 93.33 → 93.
    const r = exerciseBurn(ex({ name: "ウォーキング", durationMin: undefined }), 80);
    expect(DEFAULT_DURATION_MIN).toBe(20);
    expect(r.caloriesBurned).toBe(93);
  });

  it("falls back to the default duration when a move has no reps and no time", () => {
    // 0 reps + no time → can't estimate from reps → default duration.
    // 3.5 × 80 × (20/60) = 93.33 → 93.
    const r = exerciseBurn(
      ex({ name: "ベンチプレス", sets: 0, reps: 0, durationMin: undefined }),
      80,
    );
    expect(r.caloriesBurned).toBe(93);
  });

  it("zero or negative bodyweight yields zero burn (no fabricated number)", () => {
    expect(exerciseBurn(ex({ durationMin: 30 }), 0).caloriesBurned).toBe(0);
    expect(exerciseBurn(ex({ durationMin: 30 }), -5).caloriesBurned).toBe(0);
  });

  it("cardio with 0/no time falls back to default duration, never a rep estimate", () => {
    // ウォーキング 3×10 with no logged time: a 0 means "no time", so it uses the
    // default duration (NOT a rep-derived estimate — cardio is time-based).
    // 3.5 × 80 × (20/60) = 93. Reps do not enter the calc.
    const r = exerciseBurn(ex({ name: "ウォーキング", sets: 3, reps: 10, durationMin: 0 }), 80);
    expect(r.caloriesBurned).toBe(93);
    expect(r.method).not.toContain("回数から推定");
  });

  it("true zero burn only when bodyweight is 0 (no fabricated number)", () => {
    expect(exerciseBurn(ex({ name: "腹筋", sets: 3, reps: 20 }), 0).caloriesBurned).toBe(0);
  });
});

describe("rep-based STRENGTH burn — kcal scales with sets×reps", () => {
  it("SECONDS_PER_REP is a sensible per-rep constant (~3s)", () => {
    expect(SECONDS_PER_REP).toBe(3);
  });

  it("腹筋 3×20 with no time → estimated from reps, > 0", () => {
    // MET 3.8, 80kg. reps = 3×20 = 60. minutes = 60×3/60 = 3 → hours 0.05.
    // 3.8 × 80 × 0.05 = 15.2 → 15.
    const r = exerciseBurn(ex({ name: "腹筋", weight: 0, sets: 3, reps: 20, durationMin: undefined }), 80);
    expect(r.met).toBe(3.8);
    expect(r.caloriesBurned).toBe(15);
    expect(r.method).toContain("回数から推定");
  });

  it("腹筋 3×50 burns MORE than 3×20 (more reps → more kcal)", () => {
    const r20 = exerciseBurn(ex({ name: "腹筋", weight: 0, sets: 3, reps: 20, durationMin: undefined }), 80);
    const r50 = exerciseBurn(ex({ name: "腹筋", weight: 0, sets: 3, reps: 50, durationMin: undefined }), 80);
    // 3×50 = 150 reps → 7.5 min → 0.125h → 3.8×80×0.125 = 38.
    expect(r50.caloriesBurned).toBe(38);
    expect(r50.caloriesBurned).toBeGreaterThan(r20.caloriesBurned);
  });

  it("weighted lifts also scale with reps when no time is logged", () => {
    const few = exerciseBurn(ex({ name: "ベンチプレス", sets: 3, reps: 5, durationMin: 0 }), 80);
    const many = exerciseBurn(ex({ name: "ベンチプレス", sets: 3, reps: 15, durationMin: 0 }), 80);
    expect(many.caloriesBurned).toBeGreaterThan(few.caloriesBurned);
    expect(many.method).toContain("回数から推定");
  });

  it("explicit duration > 0 always overrides the rep estimate", () => {
    // Same 腹筋 3×50, but user logged 30 min → time path wins, ignoring reps.
    // 3.8 × 80 × 0.5 = 152.
    const r = exerciseBurn(ex({ name: "腹筋", weight: 0, sets: 3, reps: 50, durationMin: 30 }), 80);
    expect(r.caloriesBurned).toBe(152);
    expect(r.method).toContain("時間");
    expect(r.method).not.toContain("回数から推定");
  });

  it("cardio stays time-based — reps never change a running burn", () => {
    const a = exerciseBurn(ex({ name: "ランニング", sets: 3, reps: 10, durationMin: 30 }), 70);
    const b = exerciseBurn(ex({ name: "ランニング", sets: 9, reps: 99, durationMin: 30 }), 70);
    // 9.8 × 70 × 0.5 = 343 for both, regardless of sets/reps.
    expect(a.caloriesBurned).toBe(343);
    expect(b.caloriesBurned).toBe(343);
  });

  it("0 reps and 0 time is safe (no NaN, no crash) → falls back to default", () => {
    // ベンチプレス with no reps and no time: default duration, finite kcal.
    const r = exerciseBurn(ex({ name: "ベンチプレス", sets: 0, reps: 0, durationMin: undefined }), 80);
    expect(Number.isFinite(r.caloriesBurned)).toBe(true);
    expect(r.caloriesBurned).toBe(93); // 3.5 × 80 × (20/60)
  });
});

describe("isCardioName / isRepBasedStrength", () => {
  const cardio = ["ランニング", "ウォーキング", "サイクリング", "水泳", "running", "walk", "swim"];
  for (const name of cardio) {
    it(`"${name}" → cardio, not rep-based strength`, () => {
      expect(isCardioName(name)).toBe(true);
      expect(isRepBasedStrength(ex({ name, weight: 0 }))).toBe(false);
    });
  }

  const strength = ["腹筋", "腕立て伏せ", "懸垂", "プランク", "ベンチプレス", "デッドリフト"];
  for (const name of strength) {
    it(`"${name}" → rep-based strength`, () => {
      expect(isCardioName(name)).toBe(false);
      expect(isRepBasedStrength(ex({ name, weight: 0 }))).toBe(true);
    });
  }

  it("ambiguous スクワット becomes rep-based strength once it carries weight", () => {
    // No weight + no specific bodyweight/cardio match → treated as plain (falls
    // back to default time, not a rep estimate). With weight it's a weighted
    // lift, so the burn scales with reps.
    expect(isRepBasedStrength(ex({ name: "スクワット", weight: 0 }))).toBe(false);
    expect(isRepBasedStrength(ex({ name: "スクワット", weight: 60 }))).toBe(true);
  });
});

describe("workoutBurn — sum across exercises", () => {
  it("totals each exercise and floors at zero bodyweight", () => {
    const exercises: Exercise[] = [
      ex({ id: "a", name: "ベンチプレス", durationMin: 30 }), // 140
      ex({ id: "b", name: "ランニング", durationMin: 45 }), // 514
    ];
    const r = workoutBurn(exercises, 80 /* not used for running's own calc */);
    // recompute per-exercise at the given bodyweight 80:
    // bench: 3.5·80·0.5 = 140 ; running: 9.8·80·0.75 = 588 → total 728
    expect(r.totalKcal).toBe(728);
    expect(r.perExercise).toHaveLength(2);
    expect(r.perExercise[0].exerciseId).toBe("a");
  });

  it("ignores unnamed exercises", () => {
    const exercises: Exercise[] = [
      ex({ id: "a", name: "", durationMin: 30 }),
      ex({ id: "b", name: "ベンチプレス", durationMin: 30 }),
    ];
    const r = workoutBurn(exercises, 80);
    expect(r.perExercise).toHaveLength(1);
    expect(r.totalKcal).toBe(140);
  });

  it("ignores PLANNED exercises (AIプランナー 第2陣C) — a plan burns nothing yet", () => {
    const exercises: Exercise[] = [
      ex({ id: "a", name: "ベンチプレス", durationMin: 30 }), // done (no status) → 140
      ex({ id: "b", name: "ベンチプレス", durationMin: 30, status: "planned" }), // excluded
    ];
    const r = workoutBurn(exercises, 80);
    expect(r.perExercise).toHaveLength(1);
    expect(r.totalKcal).toBe(140);
    // Completing the plan (status -> done) makes it count too.
    const completed = exercises.map((e) => ({ ...e, status: "done" as const }));
    expect(workoutBurn(completed, 80).totalKcal).toBe(280);
  });

  it("empty workout → zero", () => {
    const r = workoutBurn([], 80);
    expect(r.totalKcal).toBe(0);
    expect(r.perExercise).toEqual([]);
  });

  it("bodyweight burn is still computed (背筋 carries no weight, yet burns kcal)", () => {
    // The owner-reported case: 背筋 with bodyweight. MET for 背筋 falls back to
    // the default 3.5 (no specific keyword); the burn must still be > 0 and use
    // the user's bodyweight — this is the part that must NOT break.
    const r = exerciseBurn(ex({ name: "背筋", weight: 0, durationMin: 30 }), 80);
    expect(r.met).toBe(3.5); // 3.5 × 80 × 0.5 = 140
    expect(r.caloriesBurned).toBe(140);
    expect(r.caloriesBurned).toBeGreaterThan(0);
  });
});

describe("classifier — bodyweight vs weighted", () => {
  const bodyweightNames = [
    "腹筋", "クランチ", "シットアップ", "プランク",
    "腕立て伏せ", "プッシュアップ", "懸垂", "チンニング",
    "バーピー", "背筋", "ランニング", "ウォーキング", "縄跳び",
    "push up", "pull-up",
  ];
  const weightedNames = [
    "ベンチプレス", "ショルダープレス", "アームカール", "ベントオーバーロウ",
    "デッドリフト", "ダンベルフライ", "バーベルスクワット", "ウェイトリフティング",
    "bench press", "barbell row",
  ];

  for (const name of bodyweightNames) {
    it(`"${name}" → bodyweight (not weighted)`, () => {
      expect(isBodyweightName(name)).toBe(true);
      expect(isWeightedName(name)).toBe(false);
    });
  }

  for (const name of weightedNames) {
    it(`"${name}" → weighted`, () => {
      expect(isWeightedName(name)).toBe(true);
      expect(isBodyweightName(name)).toBe(false);
    });
  }

  it("a known bodyweight move is never weighted, even with a stray weight value", () => {
    expect(isWeightedExercise(ex({ name: "背筋", weight: 99 }))).toBe(false);
    expect(isWeightedExercise(ex({ name: "腹筋", weight: 10 }))).toBe(false);
  });

  it("a known weighted move is weighted regardless of entered weight", () => {
    expect(isWeightedExercise(ex({ name: "ベンチプレス", weight: 0 }))).toBe(true);
    expect(isWeightedExercise(ex({ name: "ベンチプレス", weight: 60 }))).toBe(true);
  });

  it("ambiguous スクワット: weighted only when weight > 0, else bodyweight", () => {
    expect(isWeightedExercise(ex({ name: "スクワット", weight: 0 }))).toBe(false);
    expect(isWeightedExercise(ex({ name: "スクワット", weight: 60 }))).toBe(true);
  });

  it("an unknown name is weighted only when the user entered a weight", () => {
    expect(isWeightedExercise(ex({ name: "謎の種目", weight: 0 }))).toBe(false);
    expect(isWeightedExercise(ex({ name: "謎の種目", weight: 40 }))).toBe(true);
  });
});

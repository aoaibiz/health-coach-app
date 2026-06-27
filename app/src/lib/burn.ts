// Deterministic workout calorie-burn estimate.
//
//   kcal = MET × bodyweight(kg) × duration(hours)
//
// MET values are from the 2011 Compendium of Physical Activities (Ainsworth et
// al.). They're grounded, not fabricated, and the UI surfaces the method so the
// owner — and anyone they show the app to — can see it's an estimate.
//
// Pure functions: no DOM, no storage. Fully unit-tested.

import type { Exercise, ExerciseBurn, IntensityLevel, WorkoutBurn } from "./types";

/** Default MET when an exercise name doesn't match the table. */
export const DEFAULT_MET = 3.5; // resistance training, multiple exercises, 8-15 reps (Compendium 02054)

/**
 * Effort-level multiplier applied to the MET (Phase 5 — WORKOUT granularity).
 *
 * GROUNDED, NOT FABRICATED. The 2011 Compendium of Physical Activities encodes
 * resistance training at distinct effort-level codes:
 *   - code 02054, MET 3.5 — resistance training, multiple exercises, 8-15 reps
 *     at varied resistance (moderate effort). This is DEFAULT_MET and the 1.0×
 *     baseline.
 *   - code 02050, MET 6.0 — resistance, power lifting / body building, vigorous
 *     effort. 6.0 / 3.5 ≈ 1.71, so "hard" = 1.71×.
 *   - "light" = 0.8× is a CONSERVATIVE, LABELED estimate (not a single
 *     Compendium code): it sits between the Compendium's light-conditioning
 *     band (e.g. calisthenics light effort, code 02101 MET 2.8 → 0.8× of 3.5)
 *     and the moderate resistance baseline. The UI flags the whole burn as an
 *     estimate, so this is never presented as an authoritative figure.
 *
 * Applied multiplicatively to whatever base MET the name resolves to, so a
 * hard set of any move costs proportionally more — the same effort-scaling the
 * Compendium itself uses for resistance work.
 */
export const INTENSITY_MET_MULTIPLIER: Record<IntensityLevel, number> = {
  light: 0.8, // labeled estimate — between light-conditioning (2.8/3.5≈0.8) and moderate
  moderate: 1.0, // Compendium 02054, MET 3.5 — the unchanged baseline
  hard: 6.0 / 3.5, // Compendium 02050 (6.0 MET) vs 02054 (3.5) ≈ 1.714×
};

/** Human-readable Japanese label for an effort level (UI + method note). */
export const INTENSITY_LABEL: Record<IntensityLevel, string> = {
  light: "軽い",
  moderate: "普通",
  hard: "きつい",
};

/** The effort multiplier for an exercise; absent intensity → moderate (1.0×). */
export function intensityMultiplier(intensity?: IntensityLevel): number {
  return INTENSITY_MET_MULTIPLIER[intensity ?? "moderate"];
}
/** Default active minutes when an exercise has no duration set. */
export const DEFAULT_DURATION_MIN = 20;
/**
 * Seconds of active work per rep, used to turn sets×reps into active minutes for
 * rep-based STRENGTH moves when the user didn't log a duration. ~3s/rep is a
 * common cadence assumption (≈1s concentric + ~2s eccentric/reset). It's a
 * labeled estimate — not a measured value — so the UI flags the burn as an
 * estimate. Used as: estMinutes = sets × reps × SECONDS_PER_REP / 60.
 */
export const SECONDS_PER_REP = 3;

/**
 * Keyword → MET table. Keys are lowercase substrings matched against the
 * exercise name (Japanese or English). Ordered most-specific first so e.g.
 * "デッドリフト" wins over the generic resistance-training match.
 */
const MET_TABLE: Array<{ keywords: string[]; met: number }> = [
  // Cardio
  { keywords: ["ランニング", "running", "run"], met: 9.8 },
  { keywords: ["ジョギング", "jog"], met: 7.0 },
  { keywords: ["ウォーキング", "walking", "walk", "散歩"], met: 3.5 },
  { keywords: ["サイクリング", "バイク", "cycling", "bike", "自転車"], met: 7.5 },
  { keywords: ["水泳", "swim"], met: 8.0 },
  { keywords: ["縄跳び", "ジャンプロープ", "jump rope", "rope"], met: 12.3 },
  { keywords: ["hiit", "サーキット", "circuit"], met: 8.0 },
  // Calisthenics / bodyweight
  { keywords: ["腕立て", "プッシュアップ", "push up", "push-up", "pushup"], met: 8.0 },
  { keywords: ["懸垂", "チンニング", "pull up", "pull-up", "pullup"], met: 8.0 },
  { keywords: ["バーピー", "burpee"], met: 8.0 },
  { keywords: ["腹筋", "クランチ", "シットアップ", "sit up", "crunch"], met: 3.8 },
  { keywords: ["プランク", "plank"], met: 3.8 },
  // Resistance — specific heavy lifts
  { keywords: ["デッドリフト", "deadlift"], met: 6.0 },
  { keywords: ["スクワット", "squat", "レッグプレス", "leg press"], met: 5.0 },
  // Resistance — general (default-ish)
  {
    keywords: [
      "ベンチ",
      "bench",
      "プレス",
      "press",
      "カール",
      "curl",
      "ロウ",
      "row",
      "リフト",
      "lift",
      "ダンベル",
      "dumbbell",
      "バーベル",
      "barbell",
      "ウェイト",
      "weight",
      "筋トレ",
    ],
    met: 3.5,
  },
];

/** Look up the MET for an exercise name, falling back to the default. */
export function metForExercise(name: string): number {
  const n = name.trim().toLowerCase();
  if (!n) return DEFAULT_MET;
  for (const entry of MET_TABLE) {
    if (entry.keywords.some((k) => n.includes(k.toLowerCase()))) {
      return entry.met;
    }
  }
  return DEFAULT_MET;
}

/**
 * Movements whose load is the body itself (calisthenics + cardio). These never
 * carry an external weight, so applying weight×reps×sets to them produces a
 * nonsensical 総挙上量 (the "120kg for 背筋" bug). Reuses the same vocabulary as
 * the MET table — substring match, JP or EN, lowercase. Ordered loosely by
 * frequency; order doesn't matter since membership is a simple `some()`.
 */
const BODYWEIGHT_KEYWORDS: string[] = [
  // Core / abs / back
  "腹筋", "クランチ", "シットアップ", "sit up", "sit-up", "situp", "crunch",
  "背筋", "バックエクステンション", "back extension",
  "プランク", "plank",
  // Push / pull
  "腕立て", "プッシュアップ", "push up", "push-up", "pushup",
  "懸垂", "チンニング", "pull up", "pull-up", "pullup", "chin up", "chin-up", "chinup",
  "ディップ", "dip",
  // Conditioning / plyo
  "バーピー", "burpee",
  "ランジ", "lunge",
  "マウンテンクライマー", "mountain climber",
  "縄跳び", "ジャンプロープ", "jump rope", "rope",
  // Cardio (body is the load; distance/time, not external weight)
  "ランニング", "running", "run", "ジョギング", "jog",
  "ウォーキング", "walking", "walk", "散歩",
  "水泳", "swim",
];

/**
 * Cardio movements where the meaningful effort is *time/distance*, not reps —
 * the user logs minutes. These are a subset of BODYWEIGHT_KEYWORDS above
 * (cardio is bodyweight-loaded), broken out here only so the burn estimate can
 * keep cardio TIME-based while letting rep-based strength scale with sets×reps.
 * It does NOT change the bodyweight/weighted classification or 総挙上量 logic.
 * Substring match, JP or EN, lowercase.
 */
const CARDIO_KEYWORDS: string[] = [
  "ランニング", "running", "run", "ジョギング", "jog",
  "ウォーキング", "walking", "walk", "散歩",
  "サイクリング", "バイク", "cycling", "bike", "自転車",
  "水泳", "swim",
];

/**
 * Resistance/free-weight movements whose meaningful metric IS the external
 * weight (the 総挙上量 contributors). Substring match, JP or EN, lowercase.
 */
const WEIGHTED_KEYWORDS: string[] = [
  "ベンチ", "bench",
  "プレス", "press",
  "カール", "curl",
  "ロウ", "row",
  "リフト", "lift",
  "デッドリフト", "deadlift",
  "ダンベル", "dumbbell",
  "バーベル", "barbell",
  "ウェイト", "weight",
];

function matchesAny(name: string, keywords: string[]): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return keywords.some((k) => n.includes(k.toLowerCase()));
}

/** True when the exercise name is a clearly bodyweight/cardio movement. */
export function isBodyweightName(name: string): boolean {
  return matchesAny(name, BODYWEIGHT_KEYWORDS);
}

/** True when the exercise name is a clearly weighted/resistance movement. */
export function isWeightedName(name: string): boolean {
  return matchesAny(name, WEIGHTED_KEYWORDS);
}

/**
 * Decide whether an exercise should be treated as *weighted* (carries an
 * external load that counts toward 総挙上量) vs *bodyweight* (load is the body;
 * 0 contribution to 総挙上量, but still a valid MET-based calorie burn).
 *
 * Rules, in order:
 *   1. Known bodyweight/cardio name → bodyweight (背筋/腹筋/腕立て/ランニング…),
 *      regardless of any stray weight value. These never carry a barbell.
 *   2. Known weighted name → weighted (ベンチ/デッドリフト/ダンベル…).
 *   3. Ambiguous (e.g. スクワット, an unknown name): weighted ONLY when the user
 *      actually entered weight > 0, else bodyweight. This is the carve-out the
 *      owner asked for — a bare スクワット is air squats, not a phantom lift.
 */
export function isWeightedExercise(exercise: Exercise): boolean {
  if (isBodyweightName(exercise.name)) return false;
  if (isWeightedName(exercise.name)) return true;
  // Ambiguous name (e.g. スクワット): weighted only when real load was entered.
  // Per-set data (Phase 5) → any set carrying weight makes it a weighted lift;
  // otherwise fall back to the legacy scalar weight.
  if (exercise.setEntries && exercise.setEntries.length > 0) {
    return exercise.setEntries.some((s) => s.weight > 0);
  }
  return exercise.weight > 0;
}

/** True when the exercise name is a time/distance-based cardio movement. */
export function isCardioName(name: string): boolean {
  return matchesAny(name, CARDIO_KEYWORDS);
}

/**
 * True when an exercise's effort is best measured in REPS (sets×reps), so its
 * active duration — and thus calorie burn — should scale with reps rather than
 * defaulting to a flat time. That's every STRENGTH move: bodyweight strength
 * (腹筋/腕立て/懸垂/プランク…) and weighted lifts (ベンチ/デッドリフト/ダンベル…),
 * but NOT cardio (running/walking/cycling/swim), which stays time-based.
 *
 * Cardio is excluded first because cardio names also live in BODYWEIGHT_KEYWORDS
 * (the body is the load); the carve-out keeps cardio on the time path.
 */
export function isRepBasedStrength(exercise: Exercise): boolean {
  if (isCardioName(exercise.name)) return false;
  return isBodyweightName(exercise.name) || isWeightedExercise(exercise);
}

/**
 * Effective active minutes for the burn estimate, plus a human-readable note of
 * how it was derived (for the UI's "method" label). Priority:
 *   1. Explicit user-entered duration > 0 → use it (covers cardio: the user
 *      logs minutes for running/walking/cycling/swim).
 *   2. Rep-based STRENGTH move with reps → estimate from sets×reps:
 *      estMinutes = sets × reps × SECONDS_PER_REP / 60. So 3×50 sit-ups burns
 *      more than 3×20 — bumping reps now increases the estimate.
 *   3. Otherwise (cardio without a time, or no reps) → DEFAULT_DURATION_MIN.
 */
function effectiveMinutes(exercise: Exercise): { minutes: number; methodNote: string } {
  const explicit = exercise.durationMin ?? 0;
  if (explicit > 0) {
    return { minutes: explicit, methodNote: "MET × 体重 × 時間" };
  }
  // Per-set data (Phase 5) drives the rep count directly: Σ reps over the sets.
  // Falls back to the legacy sets × reps when no per-set breakdown exists, so
  // existing records compute identically.
  const totalReps =
    exercise.setEntries && exercise.setEntries.length > 0
      ? exercise.setEntries.reduce((s, x) => s + Math.max(0, x.reps), 0)
      : Math.max(0, exercise.sets) * Math.max(0, exercise.reps);
  if (isRepBasedStrength(exercise) && totalReps > 0) {
    return {
      minutes: (totalReps * SECONDS_PER_REP) / 60,
      methodNote: "MET × 体重 × (回数から推定した時間)",
    };
  }
  return { minutes: DEFAULT_DURATION_MIN, methodNote: "MET × 体重 × 時間 (既定値)" };
}

/** Calorie burn for a single exercise at the given bodyweight (kg). */
export function exerciseBurn(exercise: Exercise, bodyweightKg: number): ExerciseBurn {
  const baseMet = metForExercise(exercise.name);
  // Effort scaling (Phase 5): grounded in the Compendium's own moderate-vs-
  // vigorous resistance MET codes. Absent intensity → 1.0× (unchanged baseline),
  // so pre-Phase-5 records and the existing tests compute identically.
  const factor = intensityMultiplier(exercise.intensity);
  const met = Math.round(baseMet * factor * 100) / 100;
  const { minutes, methodNote } = effectiveMinutes(exercise);
  const hours = Math.max(0, minutes) / 60;
  const kg = Math.max(0, bodyweightKg);
  const caloriesBurned = Math.round(met * kg * hours);
  // Only annotate the effort when it differs from the baseline, so the default
  // method string stays byte-identical (the UI/tests rely on the base note).
  const effortNote =
    exercise.intensity && exercise.intensity !== "moderate"
      ? ` × 強度「${INTENSITY_LABEL[exercise.intensity]}」`
      : "";
  return {
    exerciseId: exercise.id,
    caloriesBurned,
    met,
    method: `${methodNote}${effortNote} (Compendium of Physical Activities)`,
  };
}

/**
 * Total burn across a workout, ignoring unnamed (blank) exercises AND not-yet-done
 * PLANS (AIプランナー 第2陣C — `status === "planned"`). A plan is a future intent,
 * not energy spent, so it must not inflate today's 消費カロリー until the user marks
 * it 完了. ABSENT status means done (every pre-feature + chat-logged exercise), so
 * this only drops the explicit "planned" ones — existing behaviour is unchanged.
 */
export function workoutBurn(exercises: Exercise[], bodyweightKg: number): WorkoutBurn {
  const perExercise = exercises
    .filter((e) => e.name.trim() !== "")
    .filter((e) => e.status !== "planned")
    .map((e) => exerciseBurn(e, bodyweightKg));
  const totalKcal = perExercise.reduce((sum, b) => sum + b.caloriesBurned, 0);
  return { totalKcal, perExercise };
}

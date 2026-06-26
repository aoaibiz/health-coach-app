// Shared domain types for the health app.

import type { Micros } from "../../functions/_lib/micros";

export type { Micros };

export type MealType = "朝" | "昼" | "夕" | "間食";

export const MEAL_TYPES: MealType[] = ["朝", "昼", "夕", "間食"];

/** Confidence of an estimate, surfaced in the UI (Phase 3). */
export type EstimateConfidence = "low" | "medium" | "high";

/**
 * Which source backs the nutrition numbers (Phase 3 — 3-tier sourced analysis):
 *   db       → 公式DB (日本食品標準成分表) — authoritative, confirmed value.
 *   label    → ラベル値 — read off the product's nutrition label in the photo.
 *   estimate → 推定値 — AI general-knowledge estimate (参考). NOT confirmed.
 * Always shown in the UI so 確定 vs 推定 is unmistakable.
 */
export type NutritionSourceKind = "db" | "label" | "estimate";

/**
 * Per-100g basis for a 公式DB item, carried client-side so editing the portion
 * recomputes EXACTLY from the official table (never from a scaled model number).
 * This is the anti-fabrication contract for db items: when present, the client
 * MUST recompute kcal/PFC as perGram × grams/100, keeping the 公式DB source.
 */
export interface FoodBasisPer100g {
  /** Matched DB row food_code, for traceability. */
  foodCode?: string;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  /**
   * Additional per-100g nutrients (「全栄養素を出す」). NULLABLE + optional so older
   * saved items (pre-feature) load fine and a DB row that doesn't measure a
   * nutrient carries null (recompute → null, shown as "—", never a fabricated 0).
   * 食物繊維(g) / 糖質(g) / 塩分=ナトリウム(mg) / 飽和脂肪(g, db常にnull)。
   */
  fiberG?: number | null;
  sugarG?: number | null;
  sodiumMg?: number | null;
  saturatedFatG?: number | null;
  /**
   * Per-100g vitamins/minerals (拡張①「ビタミン・ミネラルまで網羅」). A keyed bag
   * (functions/_lib/micros.ts), nullable per key; optional + additive so older
   * saved db items load fine. Carried so editing the portion recomputes the micros
   * EXACTLY from the official table (recompute → null per unmeasured key → "—").
   */
  micros?: Micros;
}

/**
 * One editable line item within a meal (Phase 4 — MEAL granularity). The user
 * can fine-tune grams/quantity per item and the meal total recomputes live.
 *
 * Recompute rules (anti-fabrication, mirrors functions/_lib/ground.ts):
 *   - sourceKind "db": kcal/PFC = basisPer100g × (grams × qty) / 100. The number
 *     always comes from the official DB basis, never a scaled model figure.
 *   - sourceKind "label" | "estimate": kcal/PFC scale PROPORTIONALLY from the
 *     model's original figure (baseKcal × newGrams/baseGrams) and stay labelled.
 * `grams` is the per-unit edible weight; `qty` (default 1) multiplies it. The
 * effective weight is grams × qty.
 */
export interface MealItem {
  /** Stable id within the meal (for React keys + edits). */
  id: string;
  /** Display name. */
  name: string;
  /** Per-unit edible weight in grams (before the quantity multiplier). */
  grams: number;
  /** Quantity multiplier (e.g. 2杯). Defaults to 1. Effective weight = grams × qty. */
  qty: number;
  /** Current computed kcal for the effective weight (grams × qty). */
  kcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbG: number | null;
  /**
   * Additional computed nutrients for the effective weight (「全栄養素を出す」).
   * NULLABLE + optional (additive): absent on pre-feature saved items; null when
   * the source has no figure for that nutrient. Shown as "—" when null/absent —
   * never a fabricated 0. 食物繊維(g) / 糖質(g) / 塩分=ナトリウム(mg) / 飽和脂肪(g)。
   */
  fiberG?: number | null;
  sugarG?: number | null;
  sodiumMg?: number | null;
  saturatedFatG?: number | null;
  /**
   * Current computed vitamins/minerals for the effective weight (拡張①). A keyed
   * bag, nullable per key; optional/additive (absent on pre-feature items, null
   * per key when the source has no figure → "—", never a fabricated 0).
   */
  micros?: Micros;
  /** Which source backs this item's numbers (db | label | estimate). */
  sourceKind: NutritionSourceKind;
  /** Data-source string (公式DB name, or ラベル値/推定値). */
  source?: string;
  confidence?: EstimateConfidence;
  /**
   * 公式DB basis (per-100g) for exact recompute. Present ONLY for db items so
   * the client recomputes from the official table, never from a model number.
   */
  basisPer100g?: FoodBasisPer100g;
  /**
   * Proportional-scale anchor for label/estimate items: the model's original
   * grams + its kcal/PFC for that weight. newKcal = baseKcal × newGrams/baseGrams.
   * Present ONLY for label/estimate items.
   */
  baseGrams?: number;
  baseKcal?: number | null;
  baseProteinG?: number | null;
  baseFatG?: number | null;
  baseCarbG?: number | null;
  /**
   * Proportional-scale anchors for the EXTRA nutrients of label/estimate items
   * (same contract as baseKcal etc.). Optional/nullable: absent on db items and
   * pre-feature records; null when the model gave no figure for that nutrient.
   */
  baseFiberG?: number | null;
  baseSugarG?: number | null;
  baseSodiumMg?: number | null;
  baseSaturatedFatG?: number | null;
  /**
   * Proportional-scale anchor for the EXTRA micros of label/estimate items (拡張①;
   * same contract as baseKcal). The model's micros for `baseGrams`; null per key
   * when it gave none. Present ONLY for label/estimate items.
   */
  baseMicros?: Micros;
}

/**
 * Manually-entered nutrition for a meal. Phase 1: the user types these in
 * (per the meal). Phase 3 populates them automatically from a photo/text via an
 * LLM grounded against the local MEXT DB — at which point `source`/`confidence`
 * (and optionally `generatedBy`) are attached for transparency. Phase 4 adds an
 * optional per-item `items` breakdown the user can fine-tune; the four summed
 * totals always mirror those items when present. All fields are optional so a
 * meal can be logged with no nutrition at all. Existing manually-entered records
 * remain valid (the new fields are additive).
 */
export interface MealNutrition {
  /** kcal */
  calories?: number;
  /**
   * Protein/fat/carb, grams. NULLABLE: a plain manual entry may omit them, and an
   * item-summed total is null when NO contributing item carried that macro (a meal
   * of kcal-only estimates shows protein "—", never a fabricated 0g). Shown as "—"
   * when null/absent. Same NULL-not-0 discipline as the extra nutrients below.
   */
  proteinG?: number | null;
  fatG?: number | null;
  carbG?: number | null;
  /**
   * Additional summed nutrients (「全栄養素を出す」). NULLABLE + optional (additive):
   * absent on pre-feature saved meals and plain manual entries; null when no
   * contributing item carried that nutrient (so a meal never shows a fabricated
   * "0g 食物繊維"). 食物繊維(g) / 糖質(g) / 塩分=ナトリウム(mg) / 飽和脂肪(g)。
   */
  fiberG?: number | null;
  sugarG?: number | null;
  sodiumMg?: number | null;
  saturatedFatG?: number | null;
  /**
   * Summed vitamins/minerals for the meal (拡張①). A keyed bag, nullable per key;
   * optional/additive — absent on pre-feature meals, null per key when no item
   * carried that micro (so a meal never shows a fabricated "0µg ビタミンC").
   */
  micros?: Micros;
  /**
   * Data source/method backing the numbers (e.g. "日本食品標準成分表(八訂)増補2023").
   * Present for AI-grounded estimates; absent for plain manual entry. Required
   * (when present) so a number is never shown as fact without provenance.
   */
  source?: string;
  /** Confidence of an AI estimate (Phase 3). */
  confidence?: EstimateConfidence;
  /** Model id / method that produced the estimate, for transparency. */
  generatedBy?: string;
  /**
   * Whether the numbers are an authoritative 公式DB total or include AI
   * estimate/label values. True when any contributing item was estimate/label
   * (Phase 3, 3-tier). When true the UI shows "※推定を含む".
   */
  estimated?: boolean;
  /**
   * The dominant source backing the total, for the per-meal badge:
   * "db" when every contributing item is 公式DB; "label" when label values are
   * present (no estimate); "estimate" when any estimate is included.
   */
  sourceKind?: NutritionSourceKind;
  /**
   * Per-item breakdown (Phase 4 — MEAL granularity). When present, the four
   * totals above are the sum of these items, and `estimated`/`sourceKind` are
   * derived from them. Absent for plain manual entries and pre-Phase-4 records
   * (which remain valid — the dashboard still uses the four totals directly).
   */
  items?: MealItem[];
}

export interface Meal {
  id: string;
  /** ISO date (YYYY-MM-DD) the meal belongs to. */
  date: string;
  /** Full ISO timestamp of when it was logged/eaten. */
  timestamp: string;
  type: MealType;
  text: string;
  /** IndexedDB key of the first/legacy photo, if one was attached. */
  photoId?: string;
  /** IndexedDB keys of all photos attached to this meal. Additive; photoId remains the first photo for legacy records. */
  photoIds?: string[];
  /** Optional user-entered calories + PFC for this meal (Phase 1: manual). */
  nutrition?: MealNutrition;
}

/**
 * Per-exercise effort level (Phase 5 — WORKOUT granularity). Scales the MET so
 * the calorie burn reflects how hard the set was, NOT a fabricated number.
 *
 * Grounded in the 2011 Compendium of Physical Activities, which itself encodes
 * resistance training at distinct effort-level MET codes:
 *   moderate ("普通") → code 02054, MET 3.5 (multiple exercises, 8-15 reps) — the
 *     app's existing DEFAULT_MET and the multiplier baseline (1.0×).
 *   hard     ("きつい") → code 02050, MET 6.0 (power lifting / body building,
 *     vigorous effort). 6.0/3.5 ≈ 1.71× the moderate cost.
 *   light    ("軽い") → 0.8× — a conservative, LABELED estimate sitting between
 *     the Compendium's light-conditioning band (calisthenics light 2.8) and the
 *     moderate resistance baseline. Not a single Compendium code, so it's
 *     surfaced as an estimate, never as an authoritative figure.
 * See INTENSITY_MET_MULTIPLIER in burn.ts for the numbers + citation.
 */
export type IntensityLevel = "light" | "moderate" | "hard";

/**
 * One logged set within an exercise (Phase 5 — WORKOUT granularity). The user
 * can give each set its own weight × reps, mirroring meal items' per-item
 * grams×qty. Volume = Σ weight × reps over sets (weighted moves only); burn's
 * rep estimate uses Σ reps. Default weight 0 (bodyweight / phantom-weight fix).
 */
export interface SetEntry {
  /** Stable id within the exercise (for React keys + edits). */
  id: string;
  /** Weight in kg for this set. 0 is allowed (bodyweight). */
  weight: number;
  /** Reps performed in this set. */
  reps: number;
}

export interface Exercise {
  id: string;
  name: string;
  sets: number;
  reps: number;
  /** Weight in kg. 0 is allowed (bodyweight). */
  weight: number;
  /**
   * Active duration in minutes, used for the MET-based calorie-burn estimate.
   * Optional + non-destructive: pre-existing exercises fall back to a default.
   */
  durationMin?: number;
  /**
   * Per-set breakdown (Phase 5 — WORKOUT granularity). When present, volume and
   * the burn's rep estimate derive from these sets (each with its own
   * weight×reps), and the legacy `sets`/`reps`/`weight` are kept in sync as the
   * count + a representative value for backward compatibility. Absent for
   * pre-Phase-5 records (which remain valid — volume/burn use the three scalar
   * fields directly), exactly like MealNutrition.items being optional.
   */
  setEntries?: SetEntry[];
  /**
   * Effort level scaling the MET (Phase 5). Optional + additive: absent →
   * "moderate" (1.0×, the existing baseline), so pre-existing records and the
   * burn estimate are unchanged.
   */
  intensity?: IntensityLevel;
}

export interface Workout {
  /** ISO date (YYYY-MM-DD) — one workout document per day. */
  date: string;
  exercises: Exercise[];
  updatedAt: string;
}

// ---- Sleep (睡眠メニュー) ---------------------------------------------------

/**
 * One night's sleep logged for a given calendar day (the day the user WOKE on /
 * the day they are recording for — keyed like meals/workouts by `date`). The user
 * enters 就寝時刻 (bedtime) and 起床時刻 (wakeTime) as local "HH:MM"; the duration is
 * DERIVED (sleepDurationMin), never typed in, with overnight handling (就寝23:00 →
 * 起床07:00 = 8h). One document per day (last save wins), mirroring Workout.
 *
 * Additive + self-contained: stored in its own localStorage key, so adding it
 * touches no existing meal/workout/profile data. All fields required except the
 * derived/cached minutes, which is optional so a hand-written record still loads.
 */
export interface SleepLog {
  /** ISO date (YYYY-MM-DD) the sleep belongs to. */
  date: string;
  /** 就寝時刻, local "HH:MM" (24h). */
  bedtime: string;
  /** 起床時刻, local "HH:MM" (24h). */
  wakeTime: string;
  /** Derived sleep length in minutes (overnight-aware). Optional cache; the UI
   *  recomputes from bedtime/wakeTime so a missing/garbage value can't mislead. */
  durationMin?: number;
  /** ISO timestamp of the last save (for cross-device merge parity, like Workout). */
  updatedAt: string;
}

export type Theme = "light" | "dark";

// ---- Profile & deterministic targets (Phase 1) -----------------------------

/** Calculation uses male/female; "other" falls back to the female equation. */
export type Sex = "male" | "female" | "other";
export type BodyType = "slim" | "average" | "muscular" | "heavy";
export type ActivityLevel =
  | "sedentary"
  | "light"
  | "moderate"
  | "active"
  | "very_active";
export type Goal = "lose_fat" | "maintain" | "gain_muscle";

export interface Profile {
  /**
   * Optional display name. Additive: profiles saved before this field existed
   * load fine (it's simply `undefined`).
   */
  name?: string;
  heightCm: number;
  weightKg: number;
  /**
   * Optional goal/target body weight in kilograms, used by the weight-tracking
   * feature (現在体重 vs 目標体重 and the 推移グラフ's 目標ライン). Additive +
   * optional, so profiles saved before this field existed load fine (it's
   * simply `undefined`). It does NOT feed the deterministic calorie/PFC
   * targets — those still derive from `weightKg` and the goal.
   */
  targetWeightKg?: number;
  bodyType: BodyType;
  age: number;
  sex: Sex;
  activityLevel: ActivityLevel;
  goal: Goal;
  /** Optional body-fat % (0–100). When present, BMR uses Katch-McArdle. */
  bodyFatPct?: number;
  /**
   * Optional IndexedDB key of the avatar photo, stored in the same `photos`
   * store as meal photos (see photoStore.ts). Only the id ref lives on the
   * profile in localStorage; the blob stays in IndexedDB. Additive/optional, so
   * existing saved profiles remain valid.
   */
  avatarPhotoId?: string;
  updatedAt: string;
}

/**
 * Derived daily targets — always *calculated* from a Profile, never stored.
 * Every number is grounded in a named formula (see `bmrMethod`) so nothing is
 * fabricated.
 */
export interface NutritionTargets {
  bmr: number;
  tdee: number;
  /** Target intake calories for the goal. */
  calories: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  /** e.g. "Mifflin-St Jeor" or "Katch-McArdle" — for transparency in the UI. */
  bmrMethod: string;
}

// ---- Workout calorie burn (Phase 2) ----------------------------------------

export interface ExerciseBurn {
  exerciseId: string;
  caloriesBurned: number;
  /** MET value used. */
  met: number;
  /** Calculation method/source, for transparency. */
  method: string;
}

export interface WorkoutBurn {
  totalKcal: number;
  perExercise: ExerciseBurn[];
}

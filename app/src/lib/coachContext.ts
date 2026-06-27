// Longitudinal coaching analytics — the heart of "コーチを本物のパーソナル
// トレーナーに格上げ" (Ao 2026-06-24). The existing recentDays digest gives the
// coach a raw per-day list of the last week; THIS module turns the user's whole
// logged history into the AGGREGATES a real trainer reasons from:
//   - nutrition averages over 7/14/30/90/365 days vs target (kcal + PFC), with the
//     per-day protein DEFICIT a trainer would call out,
//   - which muscle groups were trained how often recently AND across the year,
//   - per-exercise progression: is the load/volume going UP or STALLING,
//   - sleep averages over 7/30/90/365 days,
//   - the body-weight trend over the year.
// The coach reads this summary and PROACTIVELY prescribes the next step, instead
// of the "今日X kcalだからY" generalities anyone could say.
//
// HONESTY (the floor this app never crosses): every number is read straight from
// the user's own logged records and aggregated. A window with no logged data
// yields `undefined` for that metric — nothing is invented to fill a quiet
// stretch. "Untrained" means strictly "no logged set for that group in the
// window" (not-logged ≠ didn't-happen is acknowledged in the prompt wording).

import type { Exercise, Meal, NutritionTargets, Profile, SleepLog, Workout } from "./types";
import type { WeightEntry } from "./weightLog";
import { sumIntake } from "./intake";
import { isWeightedExercise } from "./burn";
import { exerciseVolume } from "./workoutSets";
import { makeSet } from "./workoutSets";
import { shiftDateKey } from "./date";
import { sleepDurationMin } from "./sleepLog";
import {
  MAIN_MUSCLE_GROUPS,
  muscleGroupForExercise,
  type MuscleGroup,
} from "./muscleGroups";

/** Windows (days, including today) the nutrition averages are computed over. */
export const NUTRITION_WINDOWS = [7, 14, 30, 90, 365] as const;
/** Windows (days, including today) the sleep averages are computed over. */
export const SLEEP_WINDOWS = [7, 30, 90, 365] as const;
/** Recent window (days) used for actionable muscle-group gaps. */
export const MUSCLE_RECENT_WINDOW_DAYS = 14;
/** Long window (days) used for annual muscle-group frequency. */
export const MUSCLE_LONG_WINDOW_DAYS = 365;
/** Window (days) used for the per-exercise progression trend. */
export const PROGRESSION_WINDOW_DAYS = 365;
/** Window (days) used for the body-weight trend. */
export const WEIGHT_TREND_DAYS = 365;
/** Max weighted exercises surfaced in the progression list (bounded prompt). */
export const MAX_PROGRESSION_EXERCISES = 6;
/** Sleep-days below this are flagged as short nights. */
export const SHORT_SLEEP_MIN = 6 * 60;
/** Sleep-days above this are flagged as long nights. */
export const LONG_SLEEP_MIN = 9 * 60;

/** Average intake vs target for one trailing window (e.g. last 7 days). */
export interface NutritionWindowAvg {
  /** Window length in days (7 / 14 / 30). */
  days: number;
  /** How many of those days had ≥1 meal with nutrition (the averaging base). */
  loggedDays: number;
  /** Mean daily kcal over the logged days (omitted when none). */
  avgKcal?: number;
  avgProteinG?: number;
  avgFatG?: number;
  avgCarbG?: number;
  /**
   * Mean daily protein SHORTFALL vs the target, in grams (target − avg, floored
   * at 0). Only set when a protein target exists AND there were logged days, so
   * the coach can say "たんぱく質が毎日約Xg不足". 0 = on/above target.
   */
  proteinDeficitG?: number;
  /** Mean daily kcal gap vs target (avg − target); +surplus / −deficit. */
  kcalVsTarget?: number;
}

/** Average sleep over one trailing window. */
export interface SleepWindowAvg {
  /** Window length in days (7 / 30 / 90 / 365). */
  days: number;
  /** How many days had a usable sleep duration. */
  loggedDays: number;
  /** Mean sleep duration in minutes over logged days. */
  avgDurationMin?: number;
  /** Count of logged days below SHORT_SLEEP_MIN. */
  shortSleepDays?: number;
  /** Count of logged days above LONG_SLEEP_MIN. */
  longSleepDays?: number;
}

/** One muscle group's training frequency over the muscle window. */
export interface MuscleGroupStat {
  group: MuscleGroup;
  /** Number of distinct DAYS this group was trained in the window. */
  daysTrained: number;
  /** Total logged sessions (exercise instances) for the group in the window. */
  sessions: number;
  /** Days since this group was last trained (within the window); null = never. */
  daysSinceLast: number | null;
}

/** Direction of an exercise's load/volume trend over the progression window. */
export type ProgressTrend = "up" | "down" | "flat" | "insufficient";

/** Per-exercise progression: is the weight/volume climbing or stalling? */
export interface ExerciseProgress {
  /** Display name (as logged; canonical-cased by first occurrence). */
  name: string;
  /** Muscle group the name maps to (for grouping in the view/prompt). */
  group: MuscleGroup;
  /** Distinct days this exercise was logged in the window. */
  sessions: number;
  /** Best (max) single-day total volume Σweight×reps seen in the window (kg). */
  bestVolumeKg: number;
  /** Best single-set top weight seen in the window (kg). */
  topWeightKg: number;
  /** Most-recent day's total volume (kg). */
  recentVolumeKg: number;
  /** Earliest (in window) day's total volume (kg) — the baseline to compare. */
  firstVolumeKg: number;
  /** Trend of recent vs first volume: up / down / flat / insufficient(<2 days). */
  trend: ProgressTrend;
}

/** Body-weight movement over the longest window. */
export interface WeightTrendSummary {
  startKg: number;
  latestKg: number;
  /** latest − start (kg, 1 decimal). Negative = lost, positive = gained. */
  deltaKg: number;
  /** Days spanned between the first and last weigh-in used. */
  spanDays: number;
}

/**
 * The full longitudinal coaching summary. Every field is optional: a brand-new
 * user with no history yields an (almost) empty object, and the coach simply has
 * less to ground on (it never invents the missing trend).
 */
export interface CoachHistory {
  /** Nutrition averages for each window (7/14/30/90/365d), most-granular first. */
  nutrition?: NutritionWindowAvg[];
  /** Sleep averages for each window (7/30/90/365d). */
  sleep?: SleepWindowAvg[];
  /** Muscle-group frequency over the recent muscle window (main groups, with gaps). */
  muscleGroups?: MuscleGroupStat[];
  /** Main groups NOT trained at all in the muscle window (the 空白 to fill). */
  untrainedGroups?: MuscleGroup[];
  /** Total distinct workout days in the muscle window (training frequency). */
  workoutDaysInWindow?: number;
  /** Size of the recent muscle window in days. */
  muscleWindowDays?: number;
  /** Muscle-group frequency over the long annual window. */
  longTermMuscleGroups?: MuscleGroupStat[];
  /** Total distinct workout days in the annual window. */
  longTermWorkoutDays?: number;
  /** Size of the long muscle window in days. */
  longTermWindowDays?: number;
  /** Per-exercise progression for the user's weighted lifts (top N, annual window). */
  progression?: ExerciseProgress[];
  /** Body-weight trend over the annual window. */
  weightTrend?: WeightTrendSummary;
}

/** One decimal place (matches the rest of the nutrition rounding). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Named, non-blank, DONE exercises only (blank placeholder rows are ignored, and
 *  a not-yet-done plan — status "planned", AIプランナー 第2陣C — is excluded so the
 *  longitudinal 部位頻度/伸び stats reflect training actually performed, not intent.
 *  ABSENT status means done, so pre-feature + chat-logged records are unchanged. */
function namedExercises(workout: Workout | undefined): Exercise[] {
  return (workout?.exercises ?? []).filter(
    (e) => e.name.trim() !== "" && e.status !== "planned",
  );
}

/**
 * The set list to measure an exercise's volume from (per-set, else legacy).
 * For a LEGACY record (no setEntries) we must EXPAND the scalar `sets` count into
 * that many identical sets — otherwise a "3 sets × 10 reps × 60kg" entry would
 * measure as one 600kg set instead of the true 1800kg total (Codex review). The
 * count is floored at 1 so a malformed sets value never drops the exercise.
 */
function setsOf(ex: Exercise): ReturnType<typeof makeSet>[] {
  if (ex.setEntries && ex.setEntries.length > 0) return ex.setEntries;
  const count = Math.max(1, Math.round(ex.sets) || 1);
  return Array.from({ length: count }, (_, i) => makeSet(`legacy-${i}`, ex.weight, ex.reps));
}

/**
 * Build the nutrition window averages (7/14/30/90/365d). For each window we sum each
 * day's intake (only days that carried nutrition count toward the average), then
 * divide by the number of LOGGED days — so a week with 3 logged days averages
 * over 3, never diluted by the empty days (a quiet day isn't a 0-kcal day).
 */
export function buildNutritionWindows(args: {
  todayKey: string;
  meals: Meal[];
  targets: NutritionTargets | null;
}): NutritionWindowAvg[] {
  const { todayKey, meals, targets } = args;
  // Group meals by day once.
  const byDay = new Map<string, Meal[]>();
  for (const m of meals) {
    const list = byDay.get(m.date);
    if (list) list.push(m);
    else byDay.set(m.date, [m]);
  }

  const out: NutritionWindowAvg[] = [];
  for (const days of NUTRITION_WINDOWS) {
    let loggedDays = 0;
    let sumKcal = 0;
    let sumP = 0;
    let sumF = 0;
    let sumC = 0;
    for (let i = 0; i < days; i++) {
      const dayKey = shiftDateKey(todayKey, -i);
      const dayMeals = byDay.get(dayKey);
      if (!dayMeals || dayMeals.length === 0) continue;
      const intake = sumIntake(dayMeals);
      if (intake.loggedCount === 0) continue; // no nutrition entered that day
      loggedDays += 1;
      sumKcal += intake.calories;
      sumP += intake.proteinG;
      sumF += intake.fatG;
      sumC += intake.carbG;
    }
    const w: NutritionWindowAvg = { days, loggedDays };
    if (loggedDays > 0) {
      w.avgKcal = Math.round(sumKcal / loggedDays);
      w.avgProteinG = Math.round(sumP / loggedDays);
      w.avgFatG = Math.round(sumF / loggedDays);
      w.avgCarbG = Math.round(sumC / loggedDays);
      if (targets) {
        w.kcalVsTarget = Math.round(w.avgKcal - targets.calories);
        const deficit = targets.proteinG - w.avgProteinG;
        w.proteinDeficitG = deficit > 0 ? Math.round(deficit) : 0;
      }
    }
    out.push(w);
  }
  return out;
}

/**
 * Build sleep window averages (7/30/90/365d). A sleep day counts only when the
 * stored bedtime/wakeTime can be converted into a positive duration; malformed
 * records are omitted rather than guessed.
 */
export function buildSleepWindows(args: {
  todayKey: string;
  sleep: Record<string, SleepLog>;
}): SleepWindowAvg[] {
  const { todayKey, sleep } = args;
  const out: SleepWindowAvg[] = [];

  for (const days of SLEEP_WINDOWS) {
    let loggedDays = 0;
    let totalMin = 0;
    let shortSleepDays = 0;
    let longSleepDays = 0;

    for (let i = 0; i < days; i++) {
      const dayKey = shiftDateKey(todayKey, -i);
      const log = sleep[dayKey];
      if (!log) continue;
      const duration = sleepDurationMin(log.bedtime, log.wakeTime);
      if (duration === null || duration <= 0) continue;
      loggedDays += 1;
      totalMin += duration;
      if (duration < SHORT_SLEEP_MIN) shortSleepDays += 1;
      if (duration > LONG_SLEEP_MIN) longSleepDays += 1;
    }

    const w: SleepWindowAvg = { days, loggedDays };
    if (loggedDays > 0) {
      w.avgDurationMin = Math.round(totalMin / loggedDays);
      w.shortSleepDays = shortSleepDays;
      w.longSleepDays = longSleepDays;
    }
    out.push(w);
  }

  return out;
}

/**
 * Build the muscle-group frequency + gap analysis over the muscle window. For
 * each MAIN group we count distinct training DAYS and total sessions, and find
 * how recently it was last trained; groups with zero days land in
 * `untrainedGroups` (the 空白 a trainer fills). Cardio/"other" don't count as a
 * strength gap, so they're excluded from the main stats + the untrained list.
 */
export function buildMuscleGroups(args: {
  todayKey: string;
  workouts: Record<string, Workout>;
  days?: number;
}): {
  muscleGroups: MuscleGroupStat[];
  untrainedGroups: MuscleGroup[];
  workoutDaysInWindow: number;
} {
  const { todayKey, workouts } = args;
  const days = args.days ?? MUSCLE_RECENT_WINDOW_DAYS;

  // For each main group: set of days trained + total sessions + min day-offset.
  const daysByGroup = new Map<MuscleGroup, Set<string>>();
  const sessionsByGroup = new Map<MuscleGroup, number>();
  const lastOffsetByGroup = new Map<MuscleGroup, number>();
  const workoutDays = new Set<string>();

  for (let i = 0; i < days; i++) {
    const dayKey = shiftDateKey(todayKey, -i);
    const exercises = namedExercises(workouts[dayKey]);
    if (exercises.length === 0) continue;
    workoutDays.add(dayKey);
    for (const ex of exercises) {
      const group = muscleGroupForExercise(ex.name);
      // Count sessions for ALL groups (so cardio still shows in the view), but the
      // gap analysis below only looks at MAIN_MUSCLE_GROUPS.
      sessionsByGroup.set(group, (sessionsByGroup.get(group) ?? 0) + 1);
      let set = daysByGroup.get(group);
      if (!set) {
        set = new Set<string>();
        daysByGroup.set(group, set);
      }
      set.add(dayKey);
      const prev = lastOffsetByGroup.get(group);
      if (prev === undefined || i < prev) lastOffsetByGroup.set(group, i);
    }
  }

  const muscleGroups: MuscleGroupStat[] = [];
  const untrainedGroups: MuscleGroup[] = [];
  for (const group of MAIN_MUSCLE_GROUPS) {
    const daysTrained = daysByGroup.get(group)?.size ?? 0;
    const sessions = sessionsByGroup.get(group) ?? 0;
    const offset = lastOffsetByGroup.get(group);
    muscleGroups.push({
      group,
      daysTrained,
      sessions,
      daysSinceLast: offset === undefined ? null : offset,
    });
    if (daysTrained === 0) untrainedGroups.push(group);
  }

  return { muscleGroups, untrainedGroups, workoutDaysInWindow: workoutDays.size };
}

/**
 * Build per-exercise progression for the user's WEIGHTED lifts over the
 * progression window. For each weighted exercise we collect its per-day total
 * volume (Σweight×reps), then compare the most-recent day to the earliest day in
 * the window to label the trend (up/down/flat). Bodyweight/cardio moves are
 * excluded (volume isn't the right metric — no 総挙上量), so the coach gets a
 * clean "are your lifts progressing?" read. Returns the top N by session count.
 */
export function buildProgression(args: {
  todayKey: string;
  workouts: Record<string, Workout>;
  days?: number;
  max?: number;
}): ExerciseProgress[] {
  const { todayKey, workouts } = args;
  const days = args.days ?? PROGRESSION_WINDOW_DAYS;
  const max = args.max ?? MAX_PROGRESSION_EXERCISES;

  // Per canonical exercise key → ordered list of {offset, volume, topWeight}.
  interface Pt {
    offset: number; // days ago (0 = today)
    volume: number;
    topWeight: number;
  }
  const byEx = new Map<string, { name: string; group: MuscleGroup; pts: Pt[] }>();

  for (let i = 0; i < days; i++) {
    const dayKey = shiftDateKey(todayKey, -i);
    const exercises = namedExercises(workouts[dayKey]);
    for (const ex of exercises) {
      if (!isWeightedExercise(ex)) continue; // weighted lifts only (volume metric)
      const key = ex.name.trim().toLowerCase();
      if (!key) continue;
      const sets = setsOf(ex);
      const volume = exerciseVolume(sets);
      if (volume <= 0) continue; // no real load logged that day → skip
      const topWeight = sets.reduce((mx, s) => Math.max(mx, s.weight), 0);
      let rec = byEx.get(key);
      if (!rec) {
        rec = { name: ex.name.trim(), group: muscleGroupForExercise(ex.name), pts: [] };
        byEx.set(key, rec);
      }
      rec.pts.push({ offset: i, volume, topWeight });
    }
  }

  const out: ExerciseProgress[] = [];
  for (const rec of byEx.values()) {
    if (rec.pts.length === 0) continue;
    // Distinct days (a day may carry the exercise once; guard anyway).
    const dayOffsets = new Set(rec.pts.map((p) => p.offset));
    const sessions = dayOffsets.size;
    // Aggregate per day (sum volume within a day; max top weight).
    const volByOffset = new Map<number, number>();
    let topWeightKg = 0;
    for (const p of rec.pts) {
      volByOffset.set(p.offset, (volByOffset.get(p.offset) ?? 0) + p.volume);
      topWeightKg = Math.max(topWeightKg, p.topWeight);
    }
    const offsetsAsc = [...volByOffset.keys()].sort((a, b) => a - b); // 0 = most recent
    const recentOffset = offsetsAsc[0];
    const firstOffset = offsetsAsc[offsetsAsc.length - 1];
    const recentVolumeKg = round1(volByOffset.get(recentOffset) ?? 0);
    const firstVolumeKg = round1(volByOffset.get(firstOffset) ?? 0);
    const bestVolumeKg = round1(Math.max(...volByOffset.values()));

    let trend: ProgressTrend;
    if (sessions < 2) {
      trend = "insufficient";
    } else {
      // ≥5% change is meaningful for volume; tighter and it's noise → flat.
      const rel = firstVolumeKg > 0 ? (recentVolumeKg - firstVolumeKg) / firstVolumeKg : 0;
      if (rel > 0.05) trend = "up";
      else if (rel < -0.05) trend = "down";
      else trend = "flat";
    }

    out.push({
      name: rec.name,
      group: rec.group,
      sessions,
      bestVolumeKg,
      topWeightKg: round1(topWeightKg),
      recentVolumeKg,
      firstVolumeKg,
      trend,
    });
  }

  // Most-trained first (the lifts the coach has the most signal on), then by best
  // volume as a tiebreak. Bounded to `max`.
  out.sort((a, b) => b.sessions - a.sessions || b.bestVolumeKg - a.bestVolumeKg);
  return out.slice(0, max);
}

/**
 * Body-weight trend over the longest window: compare the earliest in-window
 * weigh-in to the latest. Returns undefined unless there are ≥2 weigh-ins in the
 * window (a single point isn't a trend — never fabricated).
 */
export function buildWeightTrend(args: {
  todayKey: string;
  weights: WeightEntry[];
  days?: number;
}): WeightTrendSummary | undefined {
  const { todayKey, weights } = args;
  const days = args.days ?? WEIGHT_TREND_DAYS;
  const earliestKey = shiftDateKey(todayKey, -(days - 1));
  // weightLog is stored ascending by date; keep only in-window entries.
  const inWindow = weights.filter((w) => w.date >= earliestKey && w.date <= todayKey);
  if (inWindow.length < 2) return undefined;
  const start = inWindow[0];
  const latest = inWindow[inWindow.length - 1];
  // Span in days between the two dated weigh-ins.
  const startMs = new Date(start.date).getTime();
  const latestMs = new Date(latest.date).getTime();
  const spanDays = Math.max(
    0,
    Math.round((latestMs - startMs) / (24 * 60 * 60 * 1000)),
  );
  return {
    startKg: round1(start.weightKg),
    latestKg: round1(latest.weightKg),
    deltaKg: round1(latest.weightKg - start.weightKg),
    spanDays,
  };
}

/**
 * Assemble the full longitudinal coaching summary from the user's own stores.
 * Pure: the caller passes the already-loaded meals/workouts/weights + targets +
 * today's key, so there's no DOM/storage access here (SSR/test-safe). Each block
 * is only attached when it carries real signal, so a quiet history yields a
 * mostly-empty summary the coach won't over-read. Long-term windows are capped at
 * 365 days: this is enough to reason about "1年前からどう変わったか" while keeping
 * the prompt bounded.
 */
export function buildCoachHistory(args: {
  todayKey: string;
  meals: Meal[];
  workouts: Record<string, Workout>;
  sleep: Record<string, SleepLog>;
  weights: WeightEntry[];
  profile: Profile | null;
  targets: NutritionTargets | null;
}): CoachHistory {
  const { todayKey, meals, workouts, sleep, weights, targets } = args;
  const out: CoachHistory = {};

  // Nutrition windows — attach only when at least one window had a logged day.
  const nutrition = buildNutritionWindows({ todayKey, meals, targets });
  if (nutrition.some((w) => w.loggedDays > 0)) out.nutrition = nutrition;

  // Sleep windows — attach only when at least one window had a usable sleep log.
  const sleepWindows = buildSleepWindows({ todayKey, sleep });
  if (sleepWindows.some((w) => w.loggedDays > 0)) out.sleep = sleepWindows;

  // Recent muscle groups — attach only when there was at least one workout in the
  // recent window. This is the "what should we train next" gap analysis.
  const muscle = buildMuscleGroups({ todayKey, workouts, days: MUSCLE_RECENT_WINDOW_DAYS });
  if (muscle.workoutDaysInWindow > 0) {
    out.muscleWindowDays = MUSCLE_RECENT_WINDOW_DAYS;
    out.muscleGroups = muscle.muscleGroups;
    out.untrainedGroups = muscle.untrainedGroups;
    out.workoutDaysInWindow = muscle.workoutDaysInWindow;
  }

  // Annual muscle groups — a real coach also needs the long view (e.g. "this year
  // legs were trained 4 days while chest was 45"). This is separate from recent
  // gaps so the short-term prescription stays actionable.
  const longMuscle = buildMuscleGroups({ todayKey, workouts, days: MUSCLE_LONG_WINDOW_DAYS });
  if (longMuscle.workoutDaysInWindow > 0) {
    out.longTermWindowDays = MUSCLE_LONG_WINDOW_DAYS;
    out.longTermMuscleGroups = longMuscle.muscleGroups;
    out.longTermWorkoutDays = longMuscle.workoutDaysInWindow;
  }

  // Progression — attach only when there's at least one weighted lift to track.
  const progression = buildProgression({ todayKey, workouts, days: PROGRESSION_WINDOW_DAYS });
  if (progression.length > 0) out.progression = progression;

  // Weight trend — undefined unless ≥2 weigh-ins in the window.
  const weightTrend = buildWeightTrend({ todayKey, weights, days: WEIGHT_TREND_DAYS });
  if (weightTrend) out.weightTrend = weightTrend;

  return out;
}

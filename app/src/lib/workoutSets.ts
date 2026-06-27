// Per-set workout granularity (Phase 5) — the pure recompute lib for an
// exercise's sets, mirroring mealItems.ts. Lets the user give each set its own
// weight × reps and recompute volume/effort live, then keep the legacy scalar
// fields (sets/reps/weight) in sync for backward compatibility.
//
// ┌─ ANTI-FABRICATION CONTRACT (mirrors mealItems.ts) ────────────────────────┐
// │ Volume (総挙上量) is a DIRECT measurement: Σ weight × reps over the sets.   │
// │   It is never inferred or padded — a 0-weight set adds 0 (the phantom-     │
// │   weight fix). Bodyweight moves contribute 0 (handled in workout.ts).      │
// │ Calorie burn is a LABELED ESTIMATE (MET × kg × time); reps drive the time  │
// │   for strength via SECONDS_PER_REP, intensity scales the MET via a         │
// │   Compendium-grounded multiplier (see burn.ts). Nothing is invented.       │
// └────────────────────────────────────────────────────────────────────────────┘
//
// Pure functions: no DOM, no storage. Fully unit-tested.

import type { Exercise, SetEntry } from "./types";

/** Clamp a weight to a sane, non-negative range. 0 = bodyweight. */
export function clampWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  // Round to 0.25kg so 2.5kg-plate increments stay exact (no float drift).
  return Math.min(Math.round(weight * 4) / 4, 1000);
}

/** Clamp reps to a sane, non-negative integer range. 0 is allowed. */
export function clampReps(reps: number): number {
  if (!Number.isFinite(reps) || reps <= 0) return 0;
  return Math.min(Math.round(reps), 9999);
}

/** A fresh blank set. Default weight 0 (bodyweight / phantom-weight fix). */
export function makeSet(id: string, weight = 0, reps = 10): SetEntry {
  return { id, weight: clampWeight(weight), reps: clampReps(reps) };
}

/** The volume a single set contributes: weight × reps (kg). */
export function setVolume(set: SetEntry): number {
  return clampWeight(set.weight) * clampReps(set.reps);
}

/**
 * Derive the legacy scalar fields (sets/reps/weight) from a setEntries array so
 * the rest of the app (storage, the dashboard, pre-Phase-5 callers) keeps
 * working unchanged:
 *   - sets   = number of sets
 *   - reps   = TOTAL reps across sets (so the burn's sets×reps rep-derived time
 *              equals Σ reps — see note below)
 *   - weight = volume / totalReps, the rep-weighted average load, so
 *              sets×reps×weight === Σ(weight×reps) exactly. This keeps
 *              totalVolume() correct for legacy callers without changing its
 *              formula. (When totalReps is 0, weight is 0 — no phantom load.)
 *
 * Why reps = TOTAL (not per-set average): burn.ts estimates strength time as
 * sets × reps × SECONDS_PER_REP / 60. With sets=count and reps=TOTAL that
 * double-counts. To avoid touching burn.ts's formula, we instead set sets=1 and
 * reps=Σreps so the product (1 × Σreps) equals the true total rep count. The
 * dashboard/SummaryPanel read totalReps()=Σ sets×reps, which is then exactly
 * Σreps. The displayed "set count" comes from setEntries.length in the UI.
 */
export function syncLegacyFields(exercise: Exercise, sets: SetEntry[]): Exercise {
  const totalReps = sets.reduce((s, x) => s + clampReps(x.reps), 0);
  const volume = sets.reduce((s, x) => s + setVolume(x), 0);
  // weight = rep-weighted average load. sets×reps×weight reproduces the volume
  // exactly: 1 × totalReps × (volume/totalReps) === volume.
  const weight = totalReps > 0 ? volume / totalReps : 0;
  return {
    ...exercise,
    setEntries: sets,
    sets: 1,
    reps: totalReps,
    weight,
  };
}

/**
 * Total reps across an exercise's sets (Σ reps). The bodyweight-day effort
 * metric, per-exercise; mirrors workout.ts totalReps but at the set level.
 */
export function exerciseTotalReps(sets: SetEntry[]): number {
  return sets.reduce((s, x) => s + clampReps(x.reps), 0);
}

/** Total volume across an exercise's sets: Σ weight × reps (kg). */
export function exerciseVolume(sets: SetEntry[]): number {
  return sets.reduce((s, x) => s + setVolume(x), 0);
}

/**
 * The setEntries to USE for an exercise: its own array if present, else a
 * single-set view synthesized from the legacy scalar fields, so per-set code
 * can treat every exercise uniformly. A legacy exercise with sets=3, reps=10,
 * weight=60 becomes one representative set of 60kg×10 ×(implicit 3) — but for
 * the purpose of editing we expand it to N identical sets so the user can edit
 * each. `expandLegacy` controls whether to materialize N sets (for editing) or
 * keep a compact single-set view (for read-only math).
 */
export function setsFor(exercise: Exercise, makeIdFn: () => string): SetEntry[] {
  if (exercise.setEntries && exercise.setEntries.length > 0) {
    return exercise.setEntries;
  }
  // Expand the legacy single tuple into N identical editable sets.
  const count = Math.max(1, Math.round(exercise.sets) || 1);
  return Array.from({ length: count }, () =>
    makeSet(makeIdFn(), exercise.weight, exercise.reps),
  );
}

/** Set a set's weight and return a fresh set (no mutation). */
export function setSetWeight(set: SetEntry, weight: number): SetEntry {
  return { ...set, weight: clampWeight(weight) };
}

/** Set a set's reps and return a fresh set (no mutation). */
export function setSetReps(set: SetEntry, reps: number): SetEntry {
  return { ...set, reps: clampReps(reps) };
}

/**
 * Compact per-exercise summary line for the collapsed ExerciseCard (mirrors the
 * meal's "N品目" chip + totals). Returns the editable sets as a short string:
 *   - uniform sets → "60kg×10 ×3セット"  (one weight×reps line + a count)
 *   - varying sets → "60kg×10 / 70kg×8 / 80kg×6"  (each set, so nothing is lost)
 *   - bodyweight (no external load) → "×10 ×3セット" / "×20 / ×30" (no phantom kg)
 *   - no sets at all → "" (empty; the card shows its empty/0 state instead)
 *
 * Pure + display-only: never invents a number. `bodyweight` (the caller's
 * isBodyweightName/isWeightedExercise decision) controls whether kg is shown, so
 * a 自重 move never prints a weight. Used by ExerciseCard; unit-tested.
 */
export function summarizeSets(sets: SetEntry[], bodyweight: boolean): string {
  if (sets.length === 0) return "";
  const fmt = (s: SetEntry): string => {
    const reps = clampReps(s.reps);
    if (bodyweight) return `×${reps}`;
    const w = clampWeight(s.weight);
    // A 0kg set on a weighted move is still bodyweight-style (no phantom load).
    return w > 0 ? `${w}kg×${reps}` : `×${reps}`;
  };
  const allSame = sets.every(
    (s) =>
      clampWeight(s.weight) === clampWeight(sets[0].weight) &&
      clampReps(s.reps) === clampReps(sets[0].reps),
  );
  if (allSame) return `${fmt(sets[0])} ×${sets.length}セット`;
  return sets.map(fmt).join(" / ");
}

/**
 * Plain-language「何セット×何回」caption for the figure-guide block (AIプランナー
 * Phase3) — a deliberately weight-free, beginner-readable restatement of the
 * volume, so the figure reads as "do THIS, this many sets × reps".
 *
 *   - uniform reps → "3セット × 10回"
 *   - varying reps → "全3セット（合計55回）"  (so nothing is lost / invented)
 *   - no usable reps (all 0) → "" (caller hides the caption)
 *
 * Pure + display-only: counts/sums come straight from the sets, never padded.
 * Weight is intentionally OMITTED — the kg already shows in the main summary
 * line; this line is the "how many" guidance next to the picture.
 */
export function setsRepsCaption(sets: SetEntry[]): string {
  if (sets.length === 0) return "";
  const reps = sets.map((s) => clampReps(s.reps));
  const total = reps.reduce((a, b) => a + b, 0);
  if (total === 0) return "";
  const uniform = reps.every((r) => r === reps[0]);
  if (uniform) return `${sets.length}セット × ${reps[0]}回`;
  return `全${sets.length}セット（合計${total}回）`;
}

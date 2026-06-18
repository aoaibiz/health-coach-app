"use client";

import type { Exercise, IntensityLevel, SetEntry } from "@/lib/types";
import {
  exerciseBurn,
  isWeightedExercise,
  intensityMultiplier,
  INTENSITY_LABEL,
  metForExercise,
  isBodyweightName,
} from "@/lib/burn";
import {
  exerciseTotalReps,
  exerciseVolume,
  makeSet,
  setSetReps,
  setSetWeight,
  setVolume,
  syncLegacyFields,
} from "@/lib/workoutSets";
import { formatNumber } from "@/lib/workout";
import { makeId } from "@/lib/date";
import { TrashIcon } from "../icons";

/** Effort levels offered in the selector, in ascending order. */
const INTENSITY_OPTIONS: IntensityLevel[] = ["light", "moderate", "hard"];

/** Per-intensity chip styling — keeps 軽い / 普通 / きつい unmistakable. */
const INTENSITY_CHIP: Record<IntensityLevel, string> = {
  light: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  moderate: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-navy-200",
  hard: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
};

interface Props {
  exercise: Exercise;
  /** Bodyweight (kg) for the live burn estimate; null when no profile yet. */
  bodyweightKg: number | null;
  /** Called with the next exercise (sets/intensity/legacy fields synced). */
  onChange: (next: Exercise) => void;
}

/**
 * Editable per-set workout breakdown (Phase 5 — WORKOUT granularity), mirroring
 * MealItemsEditor. Each set gets its own weight (kg) × reps steppers; sets can
 * be added/removed; a per-exercise intensity (軽い/普通/きつい) scales the MET.
 * The numbers recompute live and the running total below shows volume / reps /
 * estimated burn — like the meal editor's live total.
 */
export function WorkoutSetsEditor({ exercise, bodyweightKg, onChange }: Props) {
  // The sets to render: the exercise's own array (after page.tsx materializes
  // it). Defensive fallback to a single seeded set keeps the editor non-empty.
  const sets: SetEntry[] =
    exercise.setEntries && exercise.setEntries.length > 0
      ? exercise.setEntries
      : [makeSet(makeId(), exercise.weight, exercise.reps)];

  // Bodyweight/cardio moves carry no external load → hide the 重量 stepper and
  // show a 自重 chip (phantom-weight fix).
  const bodyweight = isBodyweightName(exercise.name);
  const weighted = isWeightedExercise(exercise);

  const volume = exerciseVolume(sets);
  const totalReps = exerciseTotalReps(sets);
  const intensity = exercise.intensity ?? "moderate";
  const burn = bodyweightKg != null ? exerciseBurn(exercise, bodyweightKg) : null;

  function commit(nextSets: SetEntry[], patch?: Partial<Exercise>) {
    // syncLegacyFields keeps sets/reps/weight consistent so the dashboard,
    // SummaryPanel and storage keep working unchanged.
    onChange(syncLegacyFields({ ...exercise, ...patch }, nextSets));
  }
  function updateSet(id: string, next: SetEntry) {
    commit(sets.map((s) => (s.id === id ? next : s)));
  }
  function removeSet(id: string) {
    // Never drop the last set — an exercise always has at least one.
    if (sets.length <= 1) return;
    commit(sets.filter((s) => s.id !== id));
  }
  function addSet() {
    // New set copies the last set's weight×reps (a sane default for the next
    // working set), default 0 weight when none yet (phantom-weight fix).
    const last = sets[sets.length - 1];
    commit([...sets, makeSet(makeId(), last?.weight ?? 0, last?.reps ?? 10)]);
  }
  function setIntensity(level: IntensityLevel) {
    commit(sets, { intensity: level });
  }

  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-navy-700">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-navy-100">
          セットごとの記録
        </span>
        <span className="text-[11px] text-slate-400 dark:text-navy-400">
          重量・回数を変えると自動で再計算
        </span>
      </div>

      <ul className="space-y-2">
        {sets.map((set, idx) => (
          <SetRow
            key={set.id}
            index={idx + 1}
            set={set}
            bodyweight={bodyweight}
            weighted={weighted}
            canRemove={sets.length > 1}
            onChange={(next) => updateSet(set.id, next)}
            onRemove={() => removeSet(set.id)}
          />
        ))}
      </ul>

      {/* Add set — mirrors the meal editor's manual-add affordance. */}
      <button
        type="button"
        onClick={addSet}
        className="btn-ghost mt-2.5 w-full justify-center border border-accent/30 py-2 text-sm text-accent dark:border-accent-light/30 dark:text-accent-light"
      >
        ＋ セットを追加
      </button>

      {/* Intensity (effort) selector. */}
      <div className="mt-3 border-t border-slate-100 pt-3 dark:border-navy-800">
        <span className="mb-1.5 block text-[11px] font-medium text-slate-400 dark:text-navy-300">
          強度（消費カロリーに反映）
        </span>
        <div className="flex gap-1.5">
          {INTENSITY_OPTIONS.map((level) => {
            const active = intensity === level;
            return (
              <button
                key={level}
                type="button"
                onClick={() => setIntensity(level)}
                aria-pressed={active}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition active:scale-95 ${
                  active
                    ? INTENSITY_CHIP[level] + " ring-1 ring-inset ring-current"
                    : "bg-slate-50 text-slate-400 dark:bg-navy-800/50 dark:text-navy-400"
                }`}
              >
                {INTENSITY_LABEL[level]}
                <span className="ml-1 text-[10px] font-normal opacity-70">
                  ×{intensityMultiplier(level).toFixed(2)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Live per-exercise total. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3 dark:border-navy-800">
        <span className="text-[11px] font-semibold text-slate-500 dark:text-navy-300">合計</span>
        {burn && (
          <span className="rounded-md bg-orange-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-orange-700 dark:bg-orange-400/15 dark:text-orange-300">
            {formatNumber(burn.caloriesBurned)} kcal
          </span>
        )}
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-600 dark:bg-navy-800 dark:text-navy-200">
          {formatNumber(totalReps)} 回
        </span>
        {/* 総挙上量 only for real weighted lifts (never phantom for 自重). */}
        {weighted && volume > 0 && (
          <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs tabular-nums text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
            {formatNumber(volume)} kg（挙上量）
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400 dark:text-navy-400">
        ※消費カロリーは MET {metForExercise(exercise.name)}
        {intensity !== "moderate" ? `×${intensityMultiplier(intensity).toFixed(2)}（${INTENSITY_LABEL[intensity]}）` : ""}{" "}
        を用いた推定値です（Compendium of Physical Activities）。
      </p>
    </div>
  );
}

function SetRow({
  index,
  set,
  bodyweight,
  weighted,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  set: SetEntry;
  bodyweight: boolean;
  weighted: boolean;
  canRemove: boolean;
  onChange: (next: SetEntry) => void;
  onRemove: () => void;
}) {
  const vol = setVolume(set);
  return (
    <li className="rounded-lg bg-slate-50 p-2.5 dark:bg-navy-800/50">
      <div className="flex items-end gap-2">
        <span className="mb-2 w-8 shrink-0 text-center text-[11px] font-semibold text-slate-400 dark:text-navy-400">
          {index}set
        </span>

        {/* Weight (kg) — replaced by a 自重 chip for bodyweight moves. */}
        {bodyweight ? (
          <div className="w-24">
            <span className="mb-0.5 block text-[10px] text-slate-400 dark:text-navy-400">重量</span>
            <div className="flex h-9 items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs font-semibold text-slate-400 dark:border-navy-700 dark:text-navy-400">
              自重
            </div>
          </div>
        ) : (
          <MiniStepper
            label="重量"
            unit="kg"
            step={2.5}
            value={set.weight}
            onChange={(v) => onChange(setSetWeight(set, v))}
          />
        )}

        <MiniStepper
          label="回数"
          value={set.reps}
          step={1}
          onChange={(v) => onChange(setSetReps(set, v))}
        />

        {/* Per-set volume (weighted moves only). */}
        <div className="flex-1 text-right">
          <span className="text-sm font-semibold tabular-nums text-slate-700 dark:text-navy-100">
            {weighted && vol > 0 ? `${formatNumber(vol)} kg` : "—"}
          </span>
        </div>

        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`${index}セット目を削除`}
          className="btn-ghost mb-1 shrink-0 px-1.5 py-1 text-rose-500 hover:bg-rose-50 disabled:opacity-30 dark:hover:bg-rose-500/10"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

/** Compact -/+ stepper for per-set fields. */
function MiniStepper({
  label,
  unit,
  value,
  step = 1,
  onChange,
}: {
  label: string;
  unit?: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const shown = Number.isFinite(value) ? value : 0;
  return (
    <div className="w-24">
      <span className="mb-0.5 block text-[10px] text-slate-400 dark:text-navy-400">
        {label}
        {unit ? `(${unit})` : ""}
      </span>
      <div className="flex h-9 items-center overflow-hidden rounded-lg border border-slate-200 dark:border-navy-700">
        <button
          type="button"
          aria-label={`${label}を減らす`}
          onClick={() => onChange(Math.max(0, Math.round((shown - step) * 100) / 100))}
          className="h-full w-7 shrink-0 bg-white text-base font-medium text-slate-500 active:bg-slate-100 dark:bg-navy-900 dark:text-navy-200 dark:active:bg-navy-700"
        >
          −
        </button>
        <input
          type="number"
          inputMode="decimal"
          value={shown}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="h-full w-full min-w-0 bg-transparent text-center text-sm font-semibold tabular-nums outline-none"
          aria-label={label}
        />
        <button
          type="button"
          aria-label={`${label}を増やす`}
          onClick={() => onChange(Math.round((shown + step) * 100) / 100)}
          className="h-full w-7 shrink-0 bg-white text-base font-medium text-slate-500 active:bg-slate-100 dark:bg-navy-900 dark:text-navy-200 dark:active:bg-navy-700"
        >
          +
        </button>
      </div>
    </div>
  );
}

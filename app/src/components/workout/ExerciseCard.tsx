"use client";

import type { Exercise } from "@/lib/types";
import {
  exerciseBurn,
  isBodyweightName,
  isCardioName,
  isWeightedExercise,
  INTENSITY_LABEL,
} from "@/lib/burn";
import { formatNumber } from "@/lib/workout";
import {
  exerciseTotalReps,
  exerciseVolume,
  makeSet,
  setsRepsCaption,
  summarizeSets,
} from "@/lib/workoutSets";
import { makeId } from "@/lib/date";
import { exerciseGuideForOrDefault } from "@/lib/exerciseGuide";
import { PencilIcon, TrashIcon } from "../icons";
import { ExerciseGuideImage } from "./ExerciseGuideImage";

interface Props {
  exercise: Exercise;
  /** Bodyweight (kg) for the labeled burn estimate; null when no profile yet. */
  bodyweightKg: number | null;
  onEdit: () => void;
  onDelete: () => void;
  /**
   * Mark a PLANNED exercise done (AIプランナー 第2陣C — the 完了 button). Only
   * supplied/used for a planned exercise; absent for an already-done one (a done
   * exercise shows no 完了 button — it's already done). Calling it flips the
   * entry's status to "done" so it starts counting toward 成果/消費kcal.
   */
  onComplete?: () => void;
}

/**
 * Collapsed summary of a logged exercise — the WORKOUT mirror of MealCard. Tap
 * the body to re-open the editor; the 編集/削除 buttons match MealCard's. Shows:
 *   - name + a 自重 chip for bodyweight moves (no phantom kg)
 *   - a compact sets line ("60kg×10 ×3セット" or per-set when they differ)
 *   - 総挙上量 (kg) — ONLY for real weighted lifts (the 120kg phantom-weight fix)
 *   - 総回数 (Σ reps) — the always-meaningful effort proxy
 *   - 推定kcal — labeled MET estimate (Compendium); never a fabricated figure
 * Same white/navy surface + chip styling as MealCard.
 */
export function ExerciseCard({
  exercise,
  bodyweightKg,
  onEdit,
  onDelete,
  onComplete,
}: Props) {
  const cardio = isCardioName(exercise.name);
  const bodyweight = isBodyweightName(exercise.name);
  const weighted = isWeightedExercise(exercise);
  // Plan vs done (AIプランナー 第2陣C). ABSENT status → done (every pre-feature /
  // chat-logged exercise). A planned entry shows a 予定 chip + a 完了 button and a
  // muted surface, so the user can see it's a plan and tick it off after training.
  const planned = exercise.status === "planned";

  // Per-set view (own array, else a single set synthesized from legacy fields).
  const sets =
    exercise.setEntries && exercise.setEntries.length > 0
      ? exercise.setEntries
      : [makeSet(makeId(), exercise.weight, exercise.reps)];

  const volume = exerciseVolume(sets);
  const totalReps = cardio ? 0 : exerciseTotalReps(sets);
  // kcal is a labeled estimate; only shown once we know bodyweight (profile set).
  const burn = bodyweightKg != null ? exerciseBurn(exercise, bodyweightKg) : null;
  const intensity = exercise.intensity ?? "moderate";

  // Compact line. Cardio summarizes by time; strength by its sets.
  const line = cardio
    ? `${formatNumber(exercise.durationMin ?? 0)}分`
    : summarizeSets(sets, bodyweight || !weighted);

  // Figure guide for this move (スクワット → squat.png …). A specific move resolves
  // to its own figure; any other named strength move gets the generic default
  // figure (B方針 — every exercise shows SOME illustration). null only for an
  // empty name. Cardio moves are time-based and have no rep-figure, so we skip the
  // figure for them. The <img> onError still hides a missing/broken PNG.
  const guide = cardio ? null : exerciseGuideForOrDefault(exercise.name);

  // Plain-language「何セット×何回」line for the figure caption (strength only).
  // Uniform sets → "3セット × 10回"; mixed → "全N セット（合計M回）". Derived from
  // the same `sets` array the summary uses, so it never invents a number.
  const setsReps = cardio ? null : setsRepsCaption(sets);

  return (
    <div className="surface overflow-hidden">
      {/* Tap the body to edit — same as tapping a MealCard. */}
      <button
        type="button"
        onClick={onEdit}
        className="block w-full p-4 text-left transition active:scale-[0.99]"
        aria-label={`${exercise.name || "種目"}を編集`}
      >
        {/* Figure-guide (left) + details (right). The figure is ADDITIVE: it only
            renders when the name matches a known move AND the PNG loads, so an
            unguided exercise lays out exactly as before. */}
        <div className="flex items-start gap-3">
          {guide && (
            <div className="flex shrink-0 flex-col items-center gap-1">
              <ExerciseGuideImage guide={guide} className="h-20 w-20 sm:h-24 sm:w-24" />
              {setsReps && (
                <span className="max-w-20 text-center text-[11px] font-semibold leading-tight text-slate-500 tabular-nums dark:text-navy-300 sm:max-w-24">
                  {setsReps}
                </span>
              )}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[15px] font-semibold text-slate-800 dark:text-navy-50">
                  {exercise.name || "（無題の種目）"}
                </span>
                {planned && (
                  <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent dark:bg-accent/20 dark:text-accent-light">
                    予定
                  </span>
                )}
                {bodyweight && (
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-navy-800 dark:text-navy-300">
                    自重
                  </span>
                )}
                {intensity !== "moderate" && (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
                    {INTENSITY_LABEL[intensity]}
                  </span>
                )}
              </div>
            </div>

            {line && (
              <p className="text-sm tabular-nums text-slate-600 dark:text-navy-200">{line}</p>
            )}

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {burn && (
                <span className="rounded-md bg-orange-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-orange-700 dark:bg-orange-400/15 dark:text-orange-300">
                  推定 {formatNumber(burn.caloriesBurned)} kcal
                </span>
              )}
              {totalReps > 0 && (
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-600 dark:bg-navy-800 dark:text-navy-200">
                  {formatNumber(totalReps)} 回
                </span>
              )}
              {/* 総挙上量 only for real weighted lifts (never phantom for 自重). */}
              {weighted && volume > 0 && (
                <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs tabular-nums text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
                  {formatNumber(volume)} kg（挙上量）
                </span>
              )}
            </div>
          </div>
        </div>
      </button>

      {/* Actions row — mirrors MealCard's 編集/削除 buttons. A planned exercise also
          gets a primary 完了 button (AIプランナー 第2陣C): pressing it flips the entry
          to done so it starts counting toward 成果/消費kcal (visual FB via the chip). */}
      <div className="flex items-center justify-end gap-1 border-t border-slate-100 px-2 py-1.5 dark:border-navy-800">
        {planned && onComplete && (
          <button
            type="button"
            onClick={onComplete}
            className="mr-auto rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent/90 active:scale-[0.98] dark:bg-accent dark:hover:bg-accent/90"
          >
            完了にする
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          aria-label="編集"
          className="btn-ghost px-2 py-1.5"
        >
          <PencilIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="削除"
          className="btn-ghost px-2 py-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

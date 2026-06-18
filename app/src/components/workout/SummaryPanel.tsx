"use client";

import type { Exercise, Profile, Workout } from "@/lib/types";
import {
  exerciseCount,
  formatNumber,
  totalVolume,
  totalReps,
  weightedExerciseCount,
} from "@/lib/workout";
import { workoutBurn } from "@/lib/burn";

interface Props {
  exercises: Exercise[];
  prevWorkout: Workout | null;
  profile: Profile | null;
}

/**
 * "今日の成果" at-a-glance panel.
 *
 * The headline is 消費カロリー (MET-based — always meaningful, including for
 * bodyweight-only days). 総挙上量 is shown ONLY when the day has real weighted
 * lifts; otherwise it's omitted so a 背筋-only day never shows a misleading
 * "0kg / 120kg 総挙上量". 総回数 (Σ sets×reps) is the effort proxy that always
 * makes sense.
 */
export function SummaryPanel({ exercises, prevWorkout, profile }: Props) {
  const volume = totalVolume(exercises);
  const count = exerciseCount(exercises);
  const reps = totalReps(exercises);
  const hasWeighted = weightedExerciseCount(exercises) > 0;

  const burn = profile ? workoutBurn(exercises, profile.weightKg) : null;

  const prevHadWeighted = prevWorkout
    ? weightedExerciseCount(prevWorkout.exercises) > 0
    : false;
  const prevVolume = prevWorkout ? totalVolume(prevWorkout.exercises) : null;
  // 前日比 only when both days have weighted volume — otherwise the kg-diff is
  // meaningless (comparing a lift to a bodyweight day).
  const diff =
    hasWeighted && prevHadWeighted && prevVolume !== null
      ? volume - prevVolume
      : null;

  return (
    <div className="rounded-2xl bg-gradient-to-br from-navy-800 to-navy-950 p-5 text-white shadow-card-dark dark:from-navy-800 dark:to-navy-950">
      <p className="text-xs font-medium uppercase tracking-wider text-navy-200/80">
        今日の成果
      </p>

      {/* Headline = 消費カロリー (always meaningful). Falls back to 種目数 when
          there's no profile yet (no bodyweight → no burn estimate). */}
      {burn ? (
        <div className="mt-3 flex items-end gap-2">
          <span className="text-4xl font-bold leading-none tabular-nums text-orange-300">
            {formatNumber(burn.totalKcal)}
          </span>
          <span className="mb-0.5 text-sm font-medium text-navy-200">
            kcal・消費カロリー
          </span>
        </div>
      ) : (
        <div className="mt-3 flex items-end gap-2">
          <span className="text-4xl font-bold leading-none tabular-nums">
            {count}
          </span>
          <span className="mb-0.5 text-sm font-medium text-navy-200">
            種目・今日のトレーニング
          </span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <div>
          <span className="text-lg font-bold tabular-nums">{count}</span>
          <span className="ml-1 text-navy-200">種目</span>
        </div>

        {reps > 0 && (
          <div>
            <span className="text-lg font-bold tabular-nums">
              {formatNumber(reps)}
            </span>
            <span className="ml-1 text-navy-200">回（総回数）</span>
          </div>
        )}

        {/* 総挙上量 only when there are real weighted lifts. */}
        {hasWeighted && (
          <div>
            <span className="text-lg font-bold tabular-nums text-emerald-300">
              {formatNumber(volume)}
            </span>
            <span className="ml-1 text-navy-200">kg（総挙上量）</span>
          </div>
        )}

        {diff !== null && (
          <div className="flex items-center gap-1.5">
            <span className="text-navy-300">前日比</span>
            <span
              className={`font-semibold tabular-nums ${
                diff > 0
                  ? "text-emerald-400"
                  : diff < 0
                    ? "text-rose-400"
                    : "text-navy-200"
              }`}
            >
              {diff > 0 ? "+" : ""}
              {formatNumber(diff)} kg
            </span>
          </div>
        )}
      </div>

      {!profile && count > 0 && (
        <p className="mt-3 text-xs text-navy-300">
          プロフィールを設定すると消費カロリーが表示されます。
        </p>
      )}
    </div>
  );
}

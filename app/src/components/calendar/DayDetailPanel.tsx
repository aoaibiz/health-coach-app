"use client";

import { formatTime, formatDateLabel } from "@/lib/date";
import { formatNumber } from "@/lib/workout";
import {
  exerciseBurn,
  isBodyweightName,
  isCardioName,
  isWeightedExercise,
} from "@/lib/burn";
import { exerciseTotalReps, exerciseVolume, summarizeSets } from "@/lib/workoutSets";
import { VERDICT_LABEL, type NutrientComparison, type NutrientVerdict } from "@/lib/calendar";
import { makeSet } from "@/lib/workoutSets";
import { makeId } from "@/lib/date";
import type { DayDetail } from "./useCalendarData";
import type { Exercise } from "@/lib/types";
import { CalendarIcon, FlameIcon } from "../icons";

interface Props {
  detail: DayDetail;
  /** Bodyweight for the labeled burn estimate (day's weight, else profile). */
  bodyweightKg: number | null;
  /** True when the user has a profile (and thus targets exist). */
  hasProfile: boolean;
}

const VERDICT_STYLE: Record<NutrientVerdict, string> = {
  deficit: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  surplus: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
  unknown: "bg-slate-100 text-slate-400 dark:bg-navy-800 dark:text-navy-400",
};

/** Section heading with a thin accent rule, reused across the four blocks. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-sm font-bold text-slate-700 dark:text-navy-100">
      {children}
    </h3>
  );
}

/**
 * The selected day's history: 食事内容 / 筋トレ・運動内容 / 体重 / 栄養の過不足.
 * Every number shown is real (logged or deterministically derived) — empty
 * sections say "記録なし" rather than rendering 0 as a fact.
 */
export function DayDetailPanel({ detail, bodyweightKg, hasProfile }: Props) {
  const { meals, exercises, intake, burnKcal, volume, hasWeighted, weightKg } = detail;

  return (
    <div className="space-y-3">
      <div className="px-1 text-sm font-bold text-slate-500 dark:text-navy-300">
        {formatDateLabel(detail.date)}
      </div>

      {detail.isEmpty ? (
        <div className="surface flex flex-col items-center justify-center py-10 text-center">
          <CalendarIcon className="mb-2 h-9 w-9 text-slate-300 dark:text-navy-600" />
          <p className="text-sm font-medium text-slate-500 dark:text-navy-300">
            この日の記録はありません
          </p>
          <p className="mt-1 text-xs text-slate-400 dark:text-navy-400">
            食事・筋トレ・体重を記録するとここに表示されます
          </p>
        </div>
      ) : null}

      {/* ── 食事内容 ───────────────────────────────────────────── */}
      <section className="surface p-4">
        <SectionTitle>🍽 食事内容</SectionTitle>
        {meals.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-navy-400">記録なし</p>
        ) : (
          <div className="space-y-2">
            {meals.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 dark:bg-navy-800/50"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-navy-900 dark:text-navy-300">
                    {m.type}
                  </span>
                  <span className="truncate text-sm text-slate-700 dark:text-navy-100">
                    {m.text?.trim() || "（記録）"}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400 dark:text-navy-400">
                    {formatTime(m.timestamp)}
                  </span>
                </div>
                {m.nutrition?.calories != null && (
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700 dark:text-navy-100">
                    {formatNumber(m.nutrition.calories)}
                    <span className="text-[11px] font-normal text-slate-400"> kcal</span>
                  </span>
                )}
              </div>
            ))}

            {/* Day intake total — only when at least one meal carried nutrition. */}
            {intake.loggedCount > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2 dark:border-navy-800">
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-700 dark:bg-navy-800 dark:text-navy-100">
                  合計 {formatNumber(intake.calories)} kcal
                </span>
                <MacroChip label="P" value={intake.proteinG} className="text-rose-500" />
                <MacroChip label="F" value={intake.fatG} className="text-amber-500" />
                <MacroChip label="C" value={intake.carbG} className="text-sky-500" />
                {detail.intakeIncludesEstimate && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400">
                    ※推定を含む
                  </span>
                )}
              </div>
            )}
            {meals.length > 0 && intake.loggedCount === 0 && (
              <p className="text-[11px] text-slate-400 dark:text-navy-400">
                栄養情報は未入力です
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── 筋トレ・運動内容 ───────────────────────────────────── */}
      <section className="surface p-4">
        <SectionTitle>🏋 筋トレ・運動内容</SectionTitle>
        {exercises.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-navy-400">記録なし</p>
        ) : (
          <div className="space-y-2">
            {exercises.map((ex) => (
              <ExerciseRow key={ex.id} exercise={ex} bodyweightKg={bodyweightKg} />
            ))}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2 dark:border-navy-800">
              {bodyweightKg != null ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-orange-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-orange-700 dark:bg-orange-400/15 dark:text-orange-300">
                  <FlameIcon className="h-3.5 w-3.5" />
                  推定 {formatNumber(burnKcal)} kcal 消費
                </span>
              ) : (
                <span className="text-[11px] text-slate-400 dark:text-navy-400">
                  体重未設定のため消費kcalは未算出
                </span>
              )}
              {hasWeighted && volume > 0 && (
                <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs tabular-nums text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
                  総挙上量 {formatNumber(volume)} kg
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── 体重 ───────────────────────────────────────────────── */}
      <section className="surface p-4">
        <SectionTitle>⚖ 体重</SectionTitle>
        {weightKg == null ? (
          <p className="text-sm text-slate-400 dark:text-navy-400">記録なし</p>
        ) : (
          <p className="text-2xl font-bold tabular-nums text-slate-800 dark:text-navy-50">
            {weightKg}
            <span className="ml-1 text-sm font-medium text-slate-400">kg</span>
          </p>
        )}
      </section>

      {/* ── 栄養の過不足 ───────────────────────────────────────── */}
      <section className="surface p-4">
        <SectionTitle>📊 栄養の過不足</SectionTitle>
        {!hasProfile ? (
          <p className="text-sm leading-relaxed text-slate-400 dark:text-navy-400">
            プロフィール（目標）が未設定のため過不足は判定できません。プロフィールを設定すると、目標値と比べた過不足が表示されます。
          </p>
        ) : intake.loggedCount === 0 ? (
          <p className="text-sm text-slate-400 dark:text-navy-400">
            栄養を記録した食事がないため判定できません。
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              {detail.nutrition.map((n) => (
                <NutrientRow key={n.key} n={n} />
              ))}
            </div>
            <p className="mt-2.5 text-[10px] leading-relaxed text-slate-400 dark:text-navy-400">
              ※ 目標の±10%以内を「適正」としています。判定はカロリーとP（たんぱく質）・F（脂質）・C（炭水化物）のみ。ビタミン・ミネラルは記録していないため判定対象外です。
            </p>
          </>
        )}
      </section>
    </div>
  );
}

/** A single nutrient comparison row: label, actual / target, gap, verdict tag. */
function NutrientRow({ n }: { n: NutrientComparison }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 dark:bg-navy-800/50">
      <span className="text-sm font-medium text-slate-600 dark:text-navy-200">
        {n.label}
      </span>
      <div className="flex items-center gap-2">
        <span className="text-sm tabular-nums text-slate-500 dark:text-navy-300">
          {formatNumber(n.actual)}
          {n.target != null && (
            <span className="text-slate-400 dark:text-navy-400">
              {" "}
              / {formatNumber(n.target)}
              {n.unit}
            </span>
          )}
        </span>
        {n.gap != null && n.verdict !== "ok" && (
          <span className="text-[11px] tabular-nums text-slate-400 dark:text-navy-400">
            ({n.gap > 0 ? "+" : ""}
            {formatNumber(n.gap)})
          </span>
        )}
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-semibold ${VERDICT_STYLE[n.verdict]}`}
        >
          {VERDICT_LABEL[n.verdict]}
        </span>
      </div>
    </div>
  );
}

/** Compact logged-exercise line — mirrors ExerciseCard's summary, read-only. */
function ExerciseRow({
  exercise,
  bodyweightKg,
}: {
  exercise: Exercise;
  bodyweightKg: number | null;
}) {
  const cardio = isCardioName(exercise.name);
  const bodyweight = isBodyweightName(exercise.name);
  const weighted = isWeightedExercise(exercise);
  const sets =
    exercise.setEntries && exercise.setEntries.length > 0
      ? exercise.setEntries
      : [makeSet(makeId(), exercise.weight, exercise.reps)];
  const volume = exerciseVolume(sets);
  const reps = cardio ? 0 : exerciseTotalReps(sets);
  const burn = bodyweightKg != null ? exerciseBurn(exercise, bodyweightKg) : null;
  const line = cardio
    ? `${formatNumber(exercise.durationMin ?? 0)}分`
    : summarizeSets(sets, bodyweight || !weighted);

  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-navy-800/50">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-slate-700 dark:text-navy-100">
          {exercise.name || "（無題の種目）"}
        </span>
        {burn && (
          <span className="shrink-0 text-xs font-semibold tabular-nums text-orange-600 dark:text-orange-300">
            推定 {formatNumber(burn.caloriesBurned)} kcal
          </span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-slate-500 dark:text-navy-300">
        {line && <span>{line}</span>}
        {reps > 0 && <span>{formatNumber(reps)} 回</span>}
        {weighted && volume > 0 && <span>挙上量 {formatNumber(volume)} kg</span>}
      </div>
    </div>
  );
}

function MacroChip({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs tabular-nums text-slate-500 dark:bg-navy-800/60 dark:text-navy-300">
      <span className={`font-bold ${className}`}>{label}</span> {formatNumber(value)}g
    </span>
  );
}

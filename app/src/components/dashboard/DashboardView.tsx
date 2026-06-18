"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DateSwitcher } from "@/components/DateSwitcher";
import { useSelectedDate } from "@/components/SelectedDateProvider";
import { CalorieRing } from "@/components/CalorieRing";
import { MacroProgress } from "@/components/MacroProgress";
import { Disclaimer } from "@/components/Disclaimer";
import { WeightSection } from "@/components/dashboard/WeightSection";
import { useDailyData } from "@/components/dashboard/useDailyData";
import { hasApiKey } from "@/lib/analyzeMeal";
import { suggestNext } from "@/lib/suggest";
import { formatNumber } from "@/lib/workout";
import { ChartIcon, FlameIcon, MealIcon, UserIcon } from "@/components/icons";

export function DashboardView() {
  const { date, setDate } = useSelectedDate();
  const { data, ready } = useDailyData(date);
  const [hasKey, setHasKey] = useState(true);

  // The access key (set on the profile screen) unlocks AI解析 / 健康マン. Re-check
  // on focus/storage so the empty-state hint clears once it's been set.
  useEffect(() => {
    setHasKey(hasApiKey());
    const refresh = () => setHasKey(hasApiKey());
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return (
    <AppShell>
      <div className="space-y-4">
        <DateSwitcher date={date} onChange={setDate} />

        {ready && !data.profile ? (
          <NoProfile />
        ) : ready && data.targets ? (
          <DashboardBody data={data} hasKey={hasKey} />
        ) : null}
      </div>
    </AppShell>
  );
}

function NoProfile() {
  return (
    <div className="surface flex flex-col items-center px-6 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent dark:bg-accent-light/15 dark:text-accent-light">
        <UserIcon className="h-7 w-7" />
      </span>
      <h2 className="mt-4 text-base font-bold">まずプロフィールを設定</h2>
      <p className="mt-1.5 text-sm text-slate-500 dark:text-navy-300">
        身長・体重・目標を入力すると、1日の目標カロリーと PFC が計算されます。
      </p>
      <Link href="/profile" className="btn-primary mt-5 px-6 py-2.5">
        プロフィールを設定する
      </Link>
    </div>
  );
}

function DashboardBody({
  data,
  hasKey,
}: {
  data: ReturnType<typeof useDailyData>["data"];
  hasKey: boolean;
}) {
  const t = data.targets!;
  const { intake } = data;
  const suggestion = suggestNext(intake, t);

  return (
    <div className="space-y-4">
      {/* HERO — net calories ring + suggestion. Stays within first view. */}
      <section className="surface p-5">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-slate-500 dark:text-navy-300">
            <ChartIcon className="h-4 w-4" /> 今日の成果
          </h1>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-navy-800 dark:text-navy-300">
            目標 {t.bmrMethod}
          </span>
        </div>

        <CalorieRing net={data.netKcal} target={t.calories} />

        {/* Intake / burn breakdown under the ring */}
        <div className="mt-4 grid grid-cols-3 divide-x divide-slate-100 text-center dark:divide-navy-800">
          <Stat label="摂取" value={intake.calories} accent="text-slate-800 dark:text-navy-50" />
          <Stat label="消費" value={data.burnKcal} accent="text-orange-500" prefix="−" />
          <Stat label="ネット" value={data.netKcal} accent="text-accent dark:text-accent-light" />
        </div>

        {/* When today's intake includes an AI estimate/label value, say so. */}
        {data.intakeIncludesEstimate && (
          <p className="mt-2 text-center text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
            ※推定を含む（AI推定・ラベル値を含む合計です）
          </p>
        )}

        {/* What's missing / what to eat next */}
        <div
          className={`mt-4 flex items-start gap-2.5 rounded-xl p-3 text-sm ${
            suggestion.macro === null
              ? "bg-accent/8 text-accent dark:bg-accent-light/10 dark:text-accent-light"
              : "bg-slate-50 text-slate-700 dark:bg-navy-800/60 dark:text-navy-100"
          }`}
        >
          <MealIcon className="mt-0.5 h-5 w-5 shrink-0 opacity-70" />
          <p className="leading-relaxed">{suggestion.message}</p>
        </div>

        {/* Discoverability: point first-time users to the meal tab + AI解析. */}
        {data.mealCount === 0 && (
          <Link
            href="/meal"
            className="mt-3 flex items-start gap-2.5 rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm transition active:scale-[0.99] dark:border-accent-light/30 dark:bg-accent-light/10"
          >
            <MealIcon className="mt-0.5 h-5 w-5 shrink-0 text-accent dark:text-accent-light" />
            <span className="leading-relaxed text-slate-700 dark:text-navy-100">
              <span className="font-semibold">食事タブの ＋</span>{" "}
              から写真かテキストで記録 →「<span className="font-semibold text-accent dark:text-accent-light">✨AI解析</span>」でカロリーが出ます
            </span>
            <span className="ml-auto self-center text-accent dark:text-accent-light" aria-hidden>
              →
            </span>
          </Link>
        )}

        {/* Subtle nudge: AI解析 / 健康マン need the access key. Only when unset. */}
        {data.mealCount === 0 && !hasKey && (
          <p className="mt-2 px-1 text-center text-[11px] leading-relaxed text-slate-400 dark:text-navy-400">
            AI機能（解析・健康マン）には
            <Link href="/profile" className="font-medium text-accent underline dark:text-accent-light">
              アクセスキーの設定
            </Link>
            が必要です
          </p>
        )}
      </section>

      {/* PFC balance */}
      <section className="surface space-y-4 p-5">
        <h2 className="text-sm font-bold text-slate-700 dark:text-navy-100">
          PFC バランス
        </h2>
        <MacroProgress
          label="タンパク質"
          current={intake.proteinG}
          target={t.proteinG}
          unit="g"
          barClass="bg-rose-400 dark:bg-rose-500"
          dotClass="bg-rose-400"
        />
        <MacroProgress
          label="脂質"
          current={intake.fatG}
          target={t.fatG}
          unit="g"
          barClass="bg-amber-400 dark:bg-amber-500"
          dotClass="bg-amber-400"
        />
        <MacroProgress
          label="炭水化物"
          current={intake.carbG}
          target={t.carbG}
          unit="g"
          barClass="bg-sky-400 dark:bg-sky-500"
          dotClass="bg-sky-400"
        />
        {intake.loggedCount === 0 && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-400 dark:bg-navy-800/60 dark:text-navy-400">
            食事タブで各食事にカロリー・PFC を入力すると、ここに反映されます。
          </p>
        )}
      </section>

      {/* Weight tracking — log today's weight, current vs target, 推移グラフ */}
      <WeightSection targetWeightKg={data.profile?.targetWeightKg} />

      {/* Training */}
      <section className="surface p-5">
        <h2 className="mb-3 text-sm font-bold text-slate-700 dark:text-navy-100">
          トレーニング
        </h2>
        <div className="grid grid-cols-3 gap-2 text-center">
          {/* Lead with 消費 (MET-based — always meaningful, incl. bodyweight). */}
          <TrainStat
            label="消費"
            value={`${formatNumber(data.burnKcal)}`}
            unit="kcal"
            icon={<FlameIcon className="h-3.5 w-3.5 text-orange-500" />}
          />
          <TrainStat label="種目数" value={`${data.exerciseCount}`} unit="種目" />
          {/* 総挙上量 only on days with real weighted lifts; otherwise show
              総回数 (Σ sets×reps) so a 自重 day isn't labelled "0kg 挙上". */}
          {data.hasWeighted ? (
            <TrainStat label="総挙上量" value={`${formatNumber(data.volume)}`} unit="kg" />
          ) : (
            <TrainStat label="総回数" value={`${formatNumber(data.totalReps)}`} unit="回" />
          )}
        </div>
      </section>

      <Disclaimer className="px-1" />
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  prefix = "",
}: {
  label: string;
  value: number;
  accent: string;
  prefix?: string;
}) {
  return (
    <div className="px-1">
      <p className="text-xs text-slate-400 dark:text-navy-400">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${accent}`}>
        {value !== 0 ? prefix : ""}
        {formatNumber(value)}
      </p>
    </div>
  );
}

function TrainStat({
  label,
  value,
  unit,
  icon,
}: {
  label: string;
  value: string;
  unit: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-slate-50 py-3 dark:bg-navy-800/60">
      <p className="flex items-center justify-center gap-1 text-xs text-slate-400 dark:text-navy-400">
        {icon}
        {label}
      </p>
      <p className="mt-0.5 text-xl font-bold tabular-nums text-slate-800 dark:text-navy-50">
        {value}
        <span className="ml-0.5 text-xs font-normal text-slate-400">{unit}</span>
      </p>
    </div>
  );
}

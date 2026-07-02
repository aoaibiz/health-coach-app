"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Disclaimer } from "@/components/Disclaimer";
import { MacroProgress } from "@/components/MacroProgress";
import { WeightSection } from "@/components/dashboard/WeightSection";
import { useDailyData, type DailyData } from "@/components/dashboard/useDailyData";
import { useMeals } from "@/components/meal/useMeals";
import { useSleep } from "@/components/sleep/useSleep";
import { MicroNutrientsPanel } from "@/components/nutrition/MicroNutrientsPanel";
import { useWeekActivity, type WeekActivity } from "@/components/today/useWeekActivity";
import { hasAnyMicro } from "../../../functions/_lib/micros";
import { hasApiKey } from "@/lib/analyzeMeal";
import { suggestNext } from "@/lib/suggest";
import { formatNumber } from "@/lib/workout";
import { formatDuration, sleepDurationMin } from "@/lib/sleepLog";
import { isMealEaten } from "@/lib/mealStatus";
import { formatDateLabel, toDateKey } from "@/lib/date";
import { DATA_CHANGED_EVENT } from "@/lib/syncData";
import {
  ChatIcon,
  ChevronRightIcon,
  DumbbellIcon,
  FlameIcon,
  MealIcon,
  MoonIcon,
  SparklesIcon,
  UserIcon,
} from "@/components/icons";
import type { Meal } from "@/lib/types";

/** Time-of-day greeting (device-local clock — JST for our users). */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 4) return "こんばんは";
  if (h < 11) return "おはようございます";
  if (h < 18) return "こんにちは";
  return "こんばんは";
}

/**
 * 今日 — the app's HOME. One screen answers "今日はどう？何をすればいい？":
 * a net-calorie hero with the single next action, one-tap quick-log tiles,
 * a today-snapshot (食事/運動/睡眠), the weekly streak, PFC balance, and weight.
 * Everything is built from the SAME stores/hooks the feature pages use —
 * no new data paths, no fabrication.
 */
export function TodayView() {
  const today = toDateKey();
  const { data, ready } = useDailyData(today);
  const { dayMeals } = useMeals(today);
  const { sleep } = useSleep(today);
  const week = useWeekActivity(today);
  const [hasKey, setHasKey] = useState(true);

  // The access key (set on the profile screen) unlocks AI解析 / コーチ. Re-check
  // on focus/storage/login-restore so the hint clears once it's been set.
  useEffect(() => {
    setHasKey(hasApiKey());
    const refresh = () => setHasKey(hasApiKey());
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
  }, []);

  return (
    <AppShell>
      <div className="stagger space-y-4 pb-4 lg:pb-8">
        {/* Greeting — the human, non-card opener that makes home feel personal. */}
        <header className="px-1 pt-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-navy-400">
            {formatDateLabel(today)}
          </p>
          <h1 className="mt-0.5 text-2xl font-bold tracking-tight">{greeting()} 👋</h1>
        </header>

        {ready && (
          data.profile && data.targets ? (
            <TodayHero data={data} hasKey={hasKey} />
          ) : (
            <SetupHero />
          )
        )}

        <QuickActions />

        <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
          <TodaySnapshot
            dayMeals={dayMeals}
            data={data}
            sleepText={
              sleep ? formatDuration(sleepDurationMin(sleep.bedtime, sleep.wakeTime)) : null
            }
          />
          <WeekCard week={week} />
          {ready && data.targets && (
            <MacroCard data={data} />
          )}
          <WeightSection targetWeightKg={data.profile?.targetWeightKg} />
        </div>

        <CoachCard />

        <Disclaimer className="px-1" />
      </div>
    </AppShell>
  );
}

/* ── Hero ──────────────────────────────────────────────────────────────── */

/** White-on-gradient calorie ring (net vs target) — the home's focal point. */
function HeroRing({ net, target }: { net: number; target: number }) {
  const size = 168;
  const stroke = 13;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = target > 0 ? net / target : 0;
  const pct = Math.max(0, Math.min(1, ratio));
  const dash = circumference * pct;
  const remaining = target - net;
  const over = remaining < 0;

  return (
    <div className="relative flex items-center justify-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id="calRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#6ee7b7" />
            <stop offset="55%" stopColor="#34d399" />
            <stop offset="100%" stopColor="#a3e635" />
          </linearGradient>
          <filter id="calRingGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          stroke="rgba(255,255,255,0.08)"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          stroke={over ? "#fcd34d" : "url(#calRingGrad)"}
          strokeDasharray={`${dash} ${circumference}`}
          filter="url(#calRingGlow)"
          className="transition-[stroke-dasharray] duration-700 ease-spring"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-[2.5rem] font-bold leading-none tabular-nums text-white drop-shadow-sm">
          {formatNumber(net)}
        </span>
        <span className="mt-1 text-xs font-medium text-white/75">
          / {formatNumber(target)} kcal
        </span>
        <span
          className={`mt-2 rounded-full px-2.5 py-0.5 text-xs font-bold backdrop-blur-sm ${
            over ? "bg-amber-300/25 text-amber-100" : "bg-white/20 text-white"
          }`}
        >
          {over
            ? `+${formatNumber(Math.abs(remaining))} 超過`
            : `あと ${formatNumber(remaining)}`}
        </span>
      </div>
    </div>
  );
}

function TodayHero({ data, hasKey }: { data: DailyData; hasKey: boolean }) {
  const t = data.targets!;
  const { intake } = data;
  const suggestion = suggestNext(intake, t);

  return (
    <section className="relative overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-[#123326] via-[#0e211a] to-[#081511] p-5 text-white shadow-glow-accent ring-1 ring-white/10">
      {/* decorative accent glows — vivid green on a deep-forest surface for depth + premium contrast */}
      <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-emerald-400/20 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 h-48 w-48 rounded-full bg-lime-400/10 blur-3xl" />

      <div className="relative mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-white/85">
          今日のカロリー
        </h2>
        <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-semibold text-white/85 backdrop-blur-sm">
          目標 {t.bmrMethod}
        </span>
      </div>

      <div className="relative">
        <HeroRing net={data.netKcal} target={t.calories} />
      </div>

      {/* Intake / burn breakdown under the ring */}
      <div className="relative mt-4 grid grid-cols-3 divide-x divide-white/15 text-center">
        <HeroStat label="摂取" value={intake.calories} />
        <HeroStat label="消費" value={data.burnKcal} prefix="−" />
        <HeroStat label="ネット" value={data.netKcal} />
      </div>

      {data.intakeIncludesEstimate && (
        <p className="relative mt-2 text-center text-[11px] leading-relaxed text-amber-100/90">
          ※推定を含む（AI推定・ラベル値を含む合計です）
        </p>
      )}

      {/* The single next action — what to eat next / today's verdict. */}
      <div className="relative mt-4 flex items-start gap-2.5 rounded-2xl bg-white/15 p-3 text-sm backdrop-blur-sm">
        <SparklesIcon className="mt-0.5 h-5 w-5 shrink-0 text-white/85" />
        <p className="leading-relaxed text-white/95">{suggestion.message}</p>
      </div>

      {/* First-time discoverability: no meal yet → point to the meal tab. */}
      {data.mealCount === 0 && (
        <Link
          href="/meal"
          className="relative mt-3 flex min-h-[2.75rem] items-center justify-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-sm font-bold text-accent-700 shadow-card transition duration-200 ease-spring hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]"
        >
          <MealIcon className="h-5 w-5" />
          最初の食事を記録する
          <ChevronRightIcon className="h-4 w-4" />
        </Link>
      )}
      {data.mealCount === 0 && !hasKey && (
        <p className="relative mt-2 text-center text-[11px] leading-relaxed text-white/70">
          AI機能（解析・コーチ）には
          <Link href="/profile" className="font-semibold text-white underline">
            アクセスキーの設定
          </Link>
          が必要です
        </p>
      )}
    </section>
  );
}

function HeroStat({
  label,
  value,
  prefix = "",
}: {
  label: string;
  value: number;
  prefix?: string;
}) {
  return (
    <div className="px-1">
      <p className="text-[11px] font-medium text-white/70">{label}</p>
      <p className="text-lg font-bold tabular-nums text-white">
        {value !== 0 ? prefix : ""}
        {formatNumber(value)}
      </p>
    </div>
  );
}

/** No profile yet → the hero becomes the setup call-to-action. */
function SetupHero() {
  return (
    <section className="relative overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-[#123326] via-[#0e211a] to-[#081511] p-6 text-center text-white shadow-glow-accent ring-1 ring-white/10">
      <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-white/15 blur-3xl" />
      <span className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white/15 backdrop-blur-sm">
        <UserIcon className="h-7 w-7" />
      </span>
      <h2 className="relative mt-4 text-lg font-bold">まずはプロフィール設定から</h2>
      <p className="relative mt-1.5 text-sm leading-relaxed text-white/85">
        身長・体重・目標を入れると、1日の目標カロリーと PFC を自動計算。
        ここに今日のリングが表示されます。
      </p>
      <Link
        href="/profile"
        className="relative mt-5 inline-flex min-h-[2.75rem] items-center justify-center gap-1.5 rounded-2xl bg-white px-6 py-2.5 text-sm font-bold text-accent-700 shadow-card transition duration-200 ease-spring hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]"
      >
        プロフィールを設定する
        <ChevronRightIcon className="h-4 w-4" />
      </Link>
    </section>
  );
}

/* ── Quick actions ─────────────────────────────────────────────────────── */

const QUICK_ACTIONS = [
  {
    href: "/meal",
    label: "食事を記録",
    Icon: MealIcon,
    chip: "bg-accent-100 text-accent-700 dark:bg-accent-light/15 dark:text-accent-light",
  },
  {
    href: "/workout",
    label: "筋トレ",
    Icon: DumbbellIcon,
    chip: "bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300",
  },
  {
    href: "/cardio",
    label: "有酸素GPS",
    Icon: FlameIcon,
    chip: "bg-orange-100 text-orange-500 dark:bg-orange-400/15 dark:text-orange-300",
  },
  {
    href: "/sleep",
    label: "睡眠を記録",
    Icon: MoonIcon,
    chip: "bg-indigo-100 text-indigo-500 dark:bg-indigo-400/15 dark:text-indigo-300",
  },
];

function QuickActions() {
  return (
    <section aria-label="クイック記録" className="grid grid-cols-4 gap-2">
      {QUICK_ACTIONS.map(({ href, label, Icon, chip }) => (
        <Link key={href} href={href} className="tile">
          <span className={`icon-chip ${chip}`}>
            <Icon className="h-5 w-5" />
          </span>
          <span className="leading-tight">{label}</span>
        </Link>
      ))}
    </section>
  );
}

/* ── Today snapshot (食事 / 運動 / 睡眠 at a glance) ────────────────────── */

const MEAL_TYPES: { type: Meal["type"]; cls: string }[] = [
  { type: "朝", cls: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300" },
  { type: "昼", cls: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300" },
  { type: "夕", cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300" },
  { type: "間食", cls: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300" },
];

function TodaySnapshot({
  dayMeals,
  data,
  sleepText,
}: {
  dayMeals: Meal[];
  data: DailyData;
  sleepText: string | null;
}) {
  const eaten = dayMeals.filter(isMealEaten);
  const hasTraining = data.exerciseCount > 0;

  return (
    <section className="surface p-5">
      <h2 className="mb-3 text-sm font-bold text-slate-700 dark:text-navy-100">
        今日のあしあと
      </h2>
      <div className="space-y-1.5">
        {/* 食事 — per-type ✓ chips, so「昼を入れ忘れてる」が一目で分かる */}
        <SnapshotRow href="/meal" label="食事">
          <span className="flex flex-wrap items-center gap-1">
            {MEAL_TYPES.map(({ type, cls }) => {
              const n = eaten.filter((m) => m.type === type).length;
              return (
                <span
                  key={type}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    n > 0
                      ? cls
                      : "bg-slate-100 text-slate-300 dark:bg-navy-800 dark:text-navy-500"
                  }`}
                >
                  {type}
                  {n > 0 ? (n > 1 ? ` ×${n}` : " ✓") : ""}
                </span>
              );
            })}
          </span>
        </SnapshotRow>

        {/* 運動 */}
        <SnapshotRow href="/workout" label="運動">
          {hasTraining ? (
            <span className="text-sm font-semibold tabular-nums text-slate-700 dark:text-navy-100">
              <span className="text-orange-500">{formatNumber(data.burnKcal)} kcal</span>
              <span className="mx-1 text-slate-300 dark:text-navy-600">·</span>
              {data.exerciseCount}種目
              {data.hasWeighted && (
                <>
                  <span className="mx-1 text-slate-300 dark:text-navy-600">·</span>
                  {formatNumber(data.volume)}kg
                </>
              )}
            </span>
          ) : (
            <span className="text-xs text-slate-400 dark:text-navy-400">まだ記録なし</span>
          )}
        </SnapshotRow>

        {/* 睡眠 */}
        <SnapshotRow href="/sleep" label="睡眠">
          {sleepText ? (
            <span className="text-sm font-semibold tabular-nums text-indigo-500 dark:text-indigo-300">
              {sleepText}
            </span>
          ) : (
            <span className="text-xs text-slate-400 dark:text-navy-400">未記録</span>
          )}
        </SnapshotRow>
      </div>
    </section>
  );
}

function SnapshotRow({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-[2.75rem] items-center justify-between gap-3 rounded-xl px-2.5 py-2 transition duration-200 hover:bg-slate-50 active:scale-[0.99] dark:hover:bg-navy-800/60"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="w-9 shrink-0 text-xs font-bold text-slate-400 dark:text-navy-400">
          {label}
        </span>
        {children}
      </span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-slate-300 dark:text-navy-600" />
    </Link>
  );
}

/* ── Weekly streak ─────────────────────────────────────────────────────── */

function WeekCard({ week }: { week: WeekActivity }) {
  return (
    <section className="surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-700 dark:text-navy-100">今週の記録</h2>
        {week.streak > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2.5 py-1 text-xs font-bold text-orange-600 dark:bg-orange-400/15 dark:text-orange-300">
            <FlameIcon className="h-3.5 w-3.5" />
            連続{week.streak}日
          </span>
        )}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {week.days.map((d) => (
          <div key={d.key} className="flex flex-col items-center gap-1.5">
            <span
              className={`text-[10px] font-semibold ${
                d.isToday
                  ? "text-accent dark:text-accent-light"
                  : "text-slate-400 dark:text-navy-400"
              }`}
            >
              {d.isToday ? "今日" : d.label}
            </span>
            <span
              aria-label={`${d.key}${d.active ? "：記録あり" : "：記録なし"}`}
              className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold transition duration-300 ${
                d.active
                  ? "bg-gradient-to-b from-accent-400 to-accent-600 text-white shadow-glow-accent"
                  : `bg-slate-100 text-slate-300 dark:bg-navy-800 dark:text-navy-600 ${
                      d.isToday ? "ring-1 ring-accent/40 dark:ring-accent-light/40" : ""
                    }`
              }`}
            >
              {d.active ? "✓" : "·"}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400 dark:text-navy-400">
        {week.todayActive
          ? "今日も記録できています。この調子！"
          : "何かひとつ記録すると、今日に ✓ がつきます。"}
      </p>
    </section>
  );
}

/* ── PFC balance + その他の栄養素 ──────────────────────────────────────── */

function MacroCard({ data }: { data: DailyData }) {
  const t = data.targets!;
  const { intake } = data;
  const hasOthers =
    intake.fiberG != null ||
    intake.sugarG != null ||
    intake.sodiumMg != null ||
    intake.saturatedFatG != null ||
    hasAnyMicro(intake.micros);

  return (
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
          食事を記録すると、目標までの残りが一目で分かります。
        </p>
      )}

      {/* その他の栄養素 — collapsed by default so the home stays glanceable.
          Only rendered when the day has at least one REAL figure. */}
      {hasOthers && (
        <details className="group rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-navy-800 dark:bg-navy-800/40">
          <summary className="flex min-h-[2.25rem] cursor-pointer list-none items-center justify-between text-xs font-bold text-slate-500 dark:text-navy-300 [&::-webkit-details-marker]:hidden">
            その他の栄養素（今日の合計）
            <ChevronRightIcon className="h-4 w-4 transition-transform duration-200 group-open:rotate-90" />
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <NutrientStat label="食物繊維" value={intake.fiberG} unit="g" />
            <NutrientStat label="糖質（参考）" value={intake.sugarG} unit="g" />
            <NutrientStat label="塩分（ナトリウム）" value={intake.sodiumMg} unit="mg" />
            <NutrientStat label="飽和脂肪" value={intake.saturatedFatG} unit="g" />
          </div>
          <MicroNutrientsPanel
            micros={intake.micros}
            summary="ビタミン・ミネラル（今日の合計）"
            className="mt-2"
          />
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400 dark:text-navy-400">
            データの無い栄養素は「—」と表示します（推測で0は入れません）。
          </p>
        </details>
      )}
    </section>
  );
}

/** A nutrient figure. Null renders an honest "—" (not measured today). */
function NutrientStat({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | null;
  unit: string;
}) {
  return (
    <div className="rounded-xl bg-white px-3 py-2.5 dark:bg-navy-900/60">
      <p className="text-[11px] text-slate-400 dark:text-navy-400">{label}</p>
      <p className="mt-0.5 text-base font-bold tabular-nums text-slate-800 dark:text-navy-50">
        {value != null ? (
          <>
            {formatNumber(value)}
            <span className="ml-0.5 text-xs font-normal text-slate-400">{unit}</span>
          </>
        ) : (
          <span className="text-slate-300 dark:text-navy-500">—</span>
        )}
      </p>
    </div>
  );
}

/* ── Coach teaser ──────────────────────────────────────────────────────── */

function CoachCard() {
  return (
    <Link
      href="/chat"
      className="surface surface-interactive flex items-center gap-3.5 p-4"
    >
      <span className="icon-chip bg-gradient-to-br from-accent-light to-accent-dark text-white shadow-glow-accent">
        <ChatIcon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-slate-800 dark:text-navy-50">
          コーチに相談する
        </span>
        <span className="block text-xs text-slate-400 dark:text-navy-400">
          写真を送るだけで食事を記録・解析。メニュー提案も。
        </span>
      </span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-slate-300 dark:text-navy-600" />
    </Link>
  );
}

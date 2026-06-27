"use client";

import Link from "next/link";
import type { CoachHistory, ProgressTrend } from "@/lib/coachContext";
import {
  MUSCLE_GROUP_LABEL,
  MAIN_MUSCLE_GROUPS,
  type MuscleGroup,
} from "@/lib/muscleGroups";
import { formatNumber } from "@/lib/workout";
import { CalendarIcon, ChartIcon, DumbbellIcon, FlameIcon } from "@/components/icons";

interface Props {
  summary: CoachHistory;
  isEmpty: boolean;
  hasProfile: boolean;
}

/** Section card with a title — reused across the trend blocks. */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="surface p-4 sm:p-5">
      <h2 className="mb-3 text-sm font-bold text-slate-700 dark:text-navy-100">{title}</h2>
      {children}
    </section>
  );
}

const TREND_META: Record<ProgressTrend, { label: string; cls: string }> = {
  up: { label: "伸び", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300" },
  down: { label: "低下", cls: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300" },
  flat: { label: "停滞", cls: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300" },
  insufficient: { label: "データ不足", cls: "bg-slate-100 text-slate-400 dark:bg-navy-800 dark:text-navy-400" },
};

function formatDurationMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}時間${m}分` : `${h}時間`;
}

/**
 * 履歴・傾向（期間で遡る俯瞰）— the user sees the SAME aggregates the AI coach
 * reasons from (栄養/睡眠平均・部位頻度と空白・種目の伸び・体重推移), so "コーチが
 * 言っていること" matches "自分のデータ". Per-day drill-down lives on the calendar
 * (linked at the bottom). PC + mobile responsive; plain Japanese; no fabrication
 * (empty/quiet blocks simply don't render).
 */
export function HistoryView({ summary, isEmpty, hasProfile }: Props) {
  if (isEmpty) {
    return (
      <div className="surface flex flex-col items-center justify-center py-12 text-center">
        <ChartIcon className="mb-3 h-10 w-10 text-slate-300 dark:text-navy-600" />
        <p className="text-sm font-medium text-slate-500 dark:text-navy-300">
          まだ傾向を出せる記録がありません
        </p>
        <p className="mt-1 max-w-xs text-xs text-slate-400 dark:text-navy-400">
          食事・筋トレ・体重を数日記録すると、ここに平均カロリーや鍛えた部位、種目の伸びなどの傾向が表示されます。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── 栄養の傾向（直近7/14/30/90/365日の平均） ─────────────── */}
      {summary.nutrition && summary.nutrition.some((w) => w.loggedDays > 0) && (
        <Card title="🍽 栄養の傾向（1日あたりの平均）">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {summary.nutrition.map((w) => (
              <div
                key={w.days}
                className="rounded-2xl border border-slate-100 bg-slate-50 p-3 dark:border-navy-800 dark:bg-navy-800/40"
              >
                <p className="text-[11px] font-semibold text-slate-400 dark:text-navy-400">
                  直近{w.days}日
                  <span className="ml-1 font-normal">（記録{w.loggedDays}日）</span>
                </p>
                {w.loggedDays > 0 && w.avgKcal != null ? (
                  <>
                    <p className="mt-1 text-xl font-bold tabular-nums text-slate-800 dark:text-navy-50">
                      {formatNumber(w.avgKcal)}
                      <span className="ml-0.5 text-xs font-normal text-slate-400">kcal</span>
                    </p>
                    {w.kcalVsTarget != null && w.kcalVsTarget !== 0 && (
                      <p
                        className={`text-[11px] font-medium ${
                          w.kcalVsTarget > 0
                            ? "text-rose-500 dark:text-rose-300"
                            : "text-sky-500 dark:text-sky-300"
                        }`}
                      >
                        目標比 {w.kcalVsTarget > 0 ? "+" : ""}
                        {formatNumber(w.kcalVsTarget)}kcal
                      </p>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1 text-[11px] tabular-nums text-slate-500 dark:text-navy-300">
                      {w.avgProteinG != null && (
                        <span>
                          <span className="font-bold text-rose-500">P</span> {formatNumber(w.avgProteinG)}g
                        </span>
                      )}
                      {w.avgFatG != null && (
                        <span>
                          <span className="font-bold text-amber-500">F</span> {formatNumber(w.avgFatG)}g
                        </span>
                      )}
                      {w.avgCarbG != null && (
                        <span>
                          <span className="font-bold text-sky-500">C</span> {formatNumber(w.avgCarbG)}g
                        </span>
                      )}
                    </div>
                    {w.proteinDeficitG != null && w.proteinDeficitG > 0 && (
                      <p className="mt-1 text-[11px] font-medium text-amber-600 dark:text-amber-300">
                        たんぱく質が毎日約{formatNumber(w.proteinDeficitG)}g不足
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mt-1 text-sm text-slate-400 dark:text-navy-400">記録なし</p>
                )}
              </div>
            ))}
          </div>
          {!hasProfile && (
            <p className="mt-2 text-[11px] text-slate-400 dark:text-navy-400">
              ※ 目標との比較はプロフィール（目標）設定後に表示されます。
            </p>
          )}
        </Card>
      )}

      {/* ── 睡眠の傾向（直近7/30/90/365日の平均） ───────────────── */}
      {summary.sleep && summary.sleep.some((w) => w.loggedDays > 0) && (
        <Card title="🌙 睡眠の傾向">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {summary.sleep.map((w) => (
              <div
                key={w.days}
                className="rounded-2xl border border-slate-100 bg-slate-50 p-3 dark:border-navy-800 dark:bg-navy-800/40"
              >
                <p className="text-[11px] font-semibold text-slate-400 dark:text-navy-400">
                  直近{w.days}日
                  <span className="ml-1 font-normal">（記録{w.loggedDays}日）</span>
                </p>
                {w.loggedDays > 0 && w.avgDurationMin != null ? (
                  <>
                    <p className="mt-1 text-xl font-bold tabular-nums text-slate-800 dark:text-navy-50">
                      {formatDurationMin(w.avgDurationMin)}
                    </p>
                    {(w.shortSleepDays ?? 0) > 0 && (
                      <p className="mt-1 text-[11px] font-medium text-amber-600 dark:text-amber-300">
                        6時間未満 {w.shortSleepDays}日
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mt-1 text-sm text-slate-400 dark:text-navy-400">記録なし</p>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── 鍛えた部位 / 空白（直近2週間） ────────────────────────── */}
      {summary.muscleGroups && summary.muscleGroups.length > 0 && (
        <Card title={`🏋 鍛えた部位（直近${summary.muscleWindowDays ?? 14}日）`}>
          {typeof summary.workoutDaysInWindow === "number" && (
            <p className="mb-2 text-xs text-slate-400 dark:text-navy-400">
              運動日 {summary.workoutDaysInWindow} 日
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {MAIN_MUSCLE_GROUPS.map((g) => {
              const stat = summary.muscleGroups?.find((s) => s.group === g);
              const days = stat?.daysTrained ?? 0;
              const trained = days > 0;
              return (
                <div
                  key={g}
                  className={`rounded-xl px-3 py-2 ${
                    trained
                      ? "bg-emerald-50 dark:bg-emerald-400/10"
                      : "bg-slate-100 dark:bg-navy-800/60"
                  }`}
                >
                  <p className="text-sm font-semibold text-slate-700 dark:text-navy-100">
                    {MUSCLE_GROUP_LABEL[g as MuscleGroup]}
                  </p>
                  {trained ? (
                    <p className="text-[11px] tabular-nums text-emerald-600 dark:text-emerald-300">
                      {days}日
                      {typeof stat?.daysSinceLast === "number" &&
                        (stat.daysSinceLast === 0
                          ? "・今日"
                          : `・最後は${stat.daysSinceLast}日前`)}
                    </p>
                  ) : (
                    <p className="text-[11px] font-medium text-slate-400 dark:text-navy-400">
                      空白（未トレ）
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {summary.untrainedGroups && summary.untrainedGroups.length > 0 && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
              次に入れたい部位:{" "}
              {summary.untrainedGroups
                .map((g) => MUSCLE_GROUP_LABEL[g as MuscleGroup] ?? g)
                .join("・")}
            </p>
          )}
        </Card>
      )}

      {/* ── 年間の部位頻度 ─────────────────────────────────────── */}
      {summary.longTermMuscleGroups && summary.longTermMuscleGroups.length > 0 && (
        <Card title={`📅 長期の部位頻度（過去${summary.longTermWindowDays ?? 365}日）`}>
          {typeof summary.longTermWorkoutDays === "number" && (
            <p className="mb-2 text-xs text-slate-400 dark:text-navy-400">
              運動日 {summary.longTermWorkoutDays} 日
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {MAIN_MUSCLE_GROUPS.map((g) => {
              const stat = summary.longTermMuscleGroups?.find((s) => s.group === g);
              const days = stat?.daysTrained ?? 0;
              return (
                <div
                  key={g}
                  className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-navy-800/50"
                >
                  <p className="text-sm font-semibold text-slate-700 dark:text-navy-100">
                    {MUSCLE_GROUP_LABEL[g as MuscleGroup]}
                  </p>
                  <p className="text-[11px] tabular-nums text-slate-500 dark:text-navy-300">
                    {days}日
                    {typeof stat?.sessions === "number" && `・${stat.sessions}種目`}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── 種目の伸び（重量種目・過去1年） ───────────────────────── */}
      {summary.progression && summary.progression.length > 0 && (
        <Card title="📈 種目の伸び（重量種目・過去1年）">
          <div className="space-y-2">
            {summary.progression.map((p) => {
              const meta = TREND_META[p.trend];
              return (
                <div
                  key={p.name}
                  className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 dark:bg-navy-800/50"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <DumbbellIcon className="h-4 w-4 shrink-0 text-slate-400" />
                    <span className="truncate text-sm font-semibold text-slate-700 dark:text-navy-100">
                      {p.name}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400 dark:text-navy-400">
                      {p.sessions}回
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {p.topWeightKg > 0 && (
                      <span className="text-[11px] tabular-nums text-slate-500 dark:text-navy-300">
                        最高 {formatNumber(p.topWeightKg)}kg
                      </span>
                    )}
                    <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── 体重の推移 ───────────────────────────────────────────── */}
      {summary.weightTrend && (
        <Card title="⚖ 体重の推移">
          <div className="flex items-center gap-3">
            <FlameIcon className="h-5 w-5 text-orange-400" />
            <p className="text-sm tabular-nums text-slate-600 dark:text-navy-200">
              {formatNumber(summary.weightTrend.startKg)}kg
              <span className="mx-1 text-slate-400">→</span>
              {formatNumber(summary.weightTrend.latestKg)}kg
            </p>
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                summary.weightTrend.deltaKg < 0
                  ? "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300"
                  : summary.weightTrend.deltaKg > 0
                    ? "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300"
                    : "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-navy-300"
              }`}
            >
              {summary.weightTrend.deltaKg > 0 ? "+" : ""}
              {formatNumber(summary.weightTrend.deltaKg)}kg
            </span>
          </div>
        </Card>
      )}

      {/* 日別の細かい記録はカレンダーで遡れる導線 */}
      <Link
        href="/calendar"
        className="surface flex items-center justify-between gap-2 p-4 transition active:scale-[0.99] hover:bg-slate-50 dark:hover:bg-navy-800/60"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-navy-100">
          <CalendarIcon className="h-5 w-5 text-accent dark:text-accent-light" />
          日ごとの食事・運動・体重を見る
        </span>
        <span className="text-xs text-slate-400 dark:text-navy-400">カレンダーへ →</span>
      </Link>
    </div>
  );
}

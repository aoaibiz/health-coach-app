"use client";

import { useEffect, useState } from "react";
import { CalendarGrid } from "@/components/calendar/CalendarGrid";
import { DayDetailPanel } from "@/components/calendar/DayDetailPanel";
import { useCalendarData } from "@/components/calendar/useCalendarData";
import { HistoryView } from "@/components/history/HistoryView";
import { useHistoryData } from "@/components/history/useHistoryData";
import { useSelectedDate } from "@/components/SelectedDateProvider";
import { CalendarIcon, ChartIcon } from "@/components/icons";
import { toDateKey } from "@/lib/date";
import { monthOf, type MonthRef } from "@/lib/calendar";

export type DataHubTab = "trends" | "calendar";

/**
 * データ hub — 傾向（履歴・傾向）とカレンダー（日別履歴）をひとつの画面に統合。
 * 「振り返る」はここに集約: 期間の俯瞰はトレンド、日ごとの深掘りはカレンダー。
 * /data・/history・/calendar のどのURLからでも同じハブが開く（初期タブだけ違う）
 * ので、既存のリンク/ブックマークはすべて生きたまま。データは既存フックを
 * そのまま読む — 集計ロジックは一切変えていない。
 */
export function DataHub({ initial }: { initial: DataHubTab }) {
  const [tab, setTab] = useState<DataHubTab>(initial);

  // ── trends (the SAME aggregates the AI coach reads) ──
  const history = useHistoryData();

  // ── calendar (month grid + per-day drill-down) ──
  const calendar = useCalendarData();
  const { date: selected, setDate: setSelected } = useSelectedDate();
  const [month, setMonth] = useState<MonthRef>(() => monthOf(selected));
  // Recompute per render (cheap) so "today"/future cells stay correct across a
  // midnight rollover — never a memo frozen to the day the hub first mounted.
  const todayKey = toDateKey();

  // Keep the viewed month following the globally-shared selected day so the
  // highlight stays in view (unchanged behaviour from the calendar page).
  useEffect(() => {
    setMonth(monthOf(selected));
  }, [selected]);

  const detail = calendar.ready ? calendar.data.detailFor(selected) : null;
  const bodyweightKg = detail?.weightKg ?? calendar.data.profile?.weightKg ?? null;

  return (
    <div className="space-y-4">
      {/* Page identity — データ = sky (service colour). */}
      <header className="flex items-center gap-3">
        <span className="icon-chip bg-sky-100 text-sky-500 dark:bg-sky-400/15 dark:text-sky-300">
          <ChartIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-bold tracking-tight">データ</h1>
          <p className="text-xs text-slate-500 dark:text-navy-300">
            傾向で俯瞰、カレンダーで日ごとに振り返る
          </p>
        </div>
      </header>

      {/* Segmented control: 傾向 | カレンダー (plain buttons w/ aria-pressed — not a
          full ARIA tablist, so no misleading roles for screen readers). */}
      <div className="seg" aria-label="データの表示切替">
        <button
          type="button"
          aria-pressed={tab === "trends"}
          onClick={() => setTab("trends")}
          className={`seg-item ${tab === "trends" ? "seg-item-active" : ""}`}
        >
          <ChartIcon className="h-4 w-4" />
          傾向
        </button>
        <button
          type="button"
          aria-pressed={tab === "calendar"}
          onClick={() => setTab("calendar")}
          className={`seg-item ${tab === "calendar" ? "seg-item-active" : ""}`}
        >
          <CalendarIcon className="h-4 w-4" />
          カレンダー
        </button>
      </div>

      {tab === "trends" ? (
        <div className="animate-fade-in-up">
          {history.ready && (
            <HistoryView
              summary={history.data.summary}
              isEmpty={history.data.isEmpty}
              hasProfile={history.data.profile != null}
            />
          )}
        </div>
      ) : (
        <div className="animate-fade-in-up space-y-4">
          <CalendarGrid
            month={month}
            onMonthChange={setMonth}
            selected={selected}
            onSelect={setSelected}
            markedDays={calendar.data.markedDays}
            todayKey={todayKey}
          />
          {detail && (
            <DayDetailPanel
              detail={detail}
              bodyweightKg={bodyweightKg}
              hasProfile={calendar.data.profile != null}
            />
          )}
        </div>
      )}
    </div>
  );
}

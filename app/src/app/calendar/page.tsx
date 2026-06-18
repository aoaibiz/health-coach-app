"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { CalendarGrid } from "@/components/calendar/CalendarGrid";
import { DayDetailPanel } from "@/components/calendar/DayDetailPanel";
import { useCalendarData } from "@/components/calendar/useCalendarData";
import { useSelectedDate } from "@/components/SelectedDateProvider";
import { toDateKey } from "@/lib/date";
import { monthOf, type MonthRef } from "@/lib/calendar";

/**
 * カレンダー / 日別履歴ページ。月のカレンダーから日をタップすると、その日の
 * 食事・筋トレ・体重・栄養の過不足が表示される。すべて食事/筋トレ/体重ログから
 * 集計した実データのみ（別ストアなし・全ページ連動）。
 */
export default function CalendarPage() {
  const { data, ready } = useCalendarData();
  // The selected DAY is the globally-shared date (drives every page). The month
  // being viewed is local — free month navigation without touching the global
  // selection — but follows the selected day so its highlight stays in view.
  const { date: selected, setDate: setSelected } = useSelectedDate();
  const [month, setMonth] = useState<MonthRef>(() => monthOf(selected));
  const todayKey = useMemo(() => toDateKey(), []);

  // Keep the viewed month in sync with the shared selected day, so opening the
  // calendar (or having the date changed on another page/tab) shows that day's
  // month with the highlight visible.
  useEffect(() => {
    setMonth(monthOf(selected));
  }, [selected]);

  // Tapping a day sets the global date (and the effect above re-syncs the month,
  // e.g. tapping a trailing-month cell jumps the grid forward).
  function handleSelect(dateKey: string) {
    setSelected(dateKey);
  }

  const detail = ready ? data.detailFor(selected) : null;
  // Bodyweight for the burn estimate: the selected day's weight, else profile.
  const bodyweightKg =
    detail?.weightKg ?? data.profile?.weightKg ?? null;

  return (
    <AppShell>
      <div className="space-y-4">
        <CalendarGrid
          month={month}
          onMonthChange={setMonth}
          selected={selected}
          onSelect={handleSelect}
          markedDays={data.markedDays}
          todayKey={todayKey}
        />

        {detail && (
          <DayDetailPanel
            detail={detail}
            bodyweightKg={bodyweightKg}
            hasProfile={data.profile != null}
          />
        )}
      </div>
    </AppShell>
  );
}

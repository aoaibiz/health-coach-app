"use client";

import {
  buildMonthGrid,
  formatMonthLabel,
  shiftMonth,
  WEEKDAY_HEADERS,
  type MonthRef,
} from "@/lib/calendar";
import { ChevronLeftIcon, ChevronRightIcon } from "../icons";

interface Props {
  month: MonthRef;
  onMonthChange: (next: MonthRef) => void;
  /** Currently selected day-key. */
  selected: string;
  onSelect: (dateKey: string) => void;
  /** Day-keys that have any logged data (meal/workout/weight). */
  markedDays: Set<string>;
  /** Real today key, injected so the grid is testable + deterministic. */
  todayKey: string;
}

/**
 * Month calendar grid (Sunday-first, fixed 6×7). Days with logged data get a
 * subtle dot; today is ringed; the selected day is filled with the accent. Prev/
 * next month navigation. Tapping a day selects it (the detail panel reacts).
 * Future/empty days are still tappable — they show an honest empty state — but
 * future days are dimmed so it's clear nothing can be logged there yet.
 */
export function CalendarGrid({
  month,
  onMonthChange,
  selected,
  onSelect,
  markedDays,
  todayKey,
}: Props) {
  const cells = buildMonthGrid(month, todayKey);

  return (
    <div className="surface p-4">
      {/* Month header + navigation */}
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          aria-label="前の月"
          className="btn-ghost px-2 py-2"
          onClick={() => onMonthChange(shiftMonth(month, -1))}
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <span className="text-base font-bold tracking-tight">
          {formatMonthLabel(month)}
        </span>
        <button
          type="button"
          aria-label="次の月"
          className="btn-ghost px-2 py-2"
          onClick={() => onMonthChange(shiftMonth(month, 1))}
        >
          <ChevronRightIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Weekday header row */}
      <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-semibold text-slate-400 dark:text-navy-400">
        {WEEKDAY_HEADERS.map((w, i) => (
          <div
            key={w}
            className={
              i === 0
                ? "text-rose-400"
                : i === 6
                  ? "text-sky-400"
                  : undefined
            }
          >
            {w}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell) => {
          const isSelected = cell.key === selected;
          const marked = markedDays.has(cell.key);
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => onSelect(cell.key)}
              aria-label={`${cell.day}日`}
              aria-pressed={isSelected}
              className={[
                "relative flex aspect-square flex-col items-center justify-center rounded-xl text-sm tabular-nums transition active:scale-95",
                isSelected
                  ? "bg-accent font-bold text-white dark:bg-accent-light dark:text-navy-950"
                  : cell.isToday
                    ? "font-semibold text-accent ring-1 ring-accent/40 dark:text-accent-light dark:ring-accent-light/40"
                    : cell.inMonth
                      ? "text-slate-700 hover:bg-slate-100 dark:text-navy-100 dark:hover:bg-navy-800"
                      : "text-slate-300 dark:text-navy-600",
                !cell.inMonth || cell.isFuture ? "opacity-60" : "",
              ].join(" ")}
            >
              <span>{cell.day}</span>
              {marked && (
                <span
                  aria-hidden
                  className={`absolute bottom-1.5 h-1 w-1 rounded-full ${
                    isSelected
                      ? "bg-white dark:bg-navy-950"
                      : "bg-accent dark:bg-accent-light"
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

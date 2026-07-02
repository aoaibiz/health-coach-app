"use client";

import { formatDateLabel, isToday, shiftDateKey, toDateKey } from "@/lib/date";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

interface Props {
  date: string;
  onChange: (next: string) => void;
}

/** A compact prev / label / next switcher. Never goes past today. Rendered as a
 *  frosted pill so the day context reads as a real control on every screen. */
export function DateSwitcher({ date, onChange }: Props) {
  const today = isToday(date);
  return (
    <div className="flex items-center justify-center">
      <div className="flex items-center gap-0.5 rounded-full border border-slate-200/70 bg-white/70 p-0.5 shadow-sm backdrop-blur-md dark:border-navy-800 dark:bg-navy-900/70">
        <button
          type="button"
          aria-label="前の日"
          className="flex h-11 w-11 items-center justify-center rounded-full text-slate-500 transition duration-200 ease-spring active:scale-90 hover:bg-slate-100 dark:text-navy-300 dark:hover:bg-navy-800"
          onClick={() => onChange(shiftDateKey(date, -1))}
        >
          <ChevronLeftIcon className="h-5 w-5" />
        </button>

        <button
          type="button"
          className="flex min-h-[2.75rem] min-w-[9.5rem] items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold transition hover:bg-slate-100 dark:hover:bg-navy-800"
          onClick={() => onChange(toDateKey())}
          title="今日に戻る"
        >
          <span>{formatDateLabel(date)}</span>
          {today && (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent dark:bg-accent-light/15 dark:text-accent-light">
              今日
            </span>
          )}
        </button>

        <button
          type="button"
          aria-label="次の日"
          className="flex h-11 w-11 items-center justify-center rounded-full text-slate-500 transition duration-200 ease-spring active:scale-90 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent dark:text-navy-300 dark:hover:bg-navy-800"
          disabled={today}
          onClick={() => onChange(shiftDateKey(date, 1))}
        >
          <ChevronRightIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

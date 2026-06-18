"use client";

import { formatDateLabel, isToday, shiftDateKey, toDateKey } from "@/lib/date";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

interface Props {
  date: string;
  onChange: (next: string) => void;
}

/** A compact prev / label / next switcher. Never goes past today. */
export function DateSwitcher({ date, onChange }: Props) {
  const today = isToday(date);
  return (
    <div className="flex items-center justify-center gap-1">
      <button
        type="button"
        aria-label="前の日"
        className="btn-ghost px-2 py-2"
        onClick={() => onChange(shiftDateKey(date, -1))}
      >
        <ChevronLeftIcon className="h-5 w-5" />
      </button>

      <button
        type="button"
        className="min-w-[9.5rem] rounded-xl px-3 py-1.5 text-center text-sm font-semibold transition hover:bg-slate-100 dark:hover:bg-navy-800"
        onClick={() => onChange(toDateKey())}
        title="今日に戻る"
      >
        <span>{formatDateLabel(date)}</span>
        {today && (
          <span className="ml-1.5 align-middle text-xs font-medium text-accent dark:text-accent-light">
            今日
          </span>
        )}
      </button>

      <button
        type="button"
        aria-label="次の日"
        className="btn-ghost px-2 py-2 disabled:opacity-30 disabled:hover:bg-transparent"
        disabled={today}
        onClick={() => onChange(shiftDateKey(date, 1))}
      >
        <ChevronRightIcon className="h-5 w-5" />
      </button>
    </div>
  );
}

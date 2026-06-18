"use client";

import { formatNumber } from "@/lib/workout";

interface Props {
  label: string;
  current: number;
  target: number;
  unit: string;
  /** Tailwind classes for the filled portion of the bar. */
  barClass: string;
  /** Tailwind text color for the label dot. */
  dotClass: string;
}

/**
 * A labeled progress bar: "残り" until the target is met, "+over" once exceeded.
 * Used for calories and each macro on the dashboard.
 */
export function MacroProgress({
  label,
  current,
  target,
  unit,
  barClass,
  dotClass,
}: Props) {
  const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const remaining = target - current;
  const over = remaining < 0;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium text-slate-600 dark:text-navy-200">
          <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
          {label}
        </span>
        <span className="text-sm tabular-nums text-slate-500 dark:text-navy-300">
          <span className="font-bold text-slate-900 dark:text-navy-50">
            {formatNumber(current)}
          </span>
          <span className="text-slate-400 dark:text-navy-400">
            {" "}
            / {formatNumber(target)} {unit}
          </span>
        </span>
      </div>

      <div
        className="h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-navy-800"
        role="progressbar"
        aria-valuenow={Math.round(current)}
        aria-valuemin={0}
        aria-valuemax={Math.round(target)}
        aria-label={`${label}: ${formatNumber(current)} / ${formatNumber(target)} ${unit}`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${over ? "bg-amber-400 dark:bg-amber-500" : barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="mt-1 text-xs text-slate-400 dark:text-navy-400">
        {over ? (
          <span className="font-medium text-amber-600 dark:text-amber-400">
            目標を {formatNumber(Math.abs(remaining))} {unit} 超過
          </span>
        ) : (
          <>
            あと{" "}
            <span className="font-medium text-slate-600 dark:text-navy-200">
              {formatNumber(remaining)} {unit}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

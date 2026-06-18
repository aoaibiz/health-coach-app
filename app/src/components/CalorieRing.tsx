"use client";

import { formatNumber } from "@/lib/workout";

interface Props {
  /** Net intake (meals − burn). */
  net: number;
  target: number;
}

/**
 * The dashboard hero: a circular progress ring showing net calories vs target.
 * Pure SVG (no chart library) to keep the bundle small, per the design system.
 */
export function CalorieRing({ net, target }: Props) {
  const size = 180;
  const stroke = 14;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = target > 0 ? net / target : 0;
  const pct = Math.max(0, Math.min(1, ratio));
  const dash = circumference * pct;
  const remaining = target - net;
  const over = remaining < 0;

  return (
    <div className="relative flex items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden
      >
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-slate-100 dark:stroke-navy-800"
        />
        {/* Progress */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          className={
            over
              ? "stroke-amber-400 dark:stroke-amber-500 transition-[stroke-dasharray] duration-700"
              : "stroke-accent dark:stroke-accent-light transition-[stroke-dasharray] duration-700"
          }
        />
      </svg>

      <div className="absolute flex flex-col items-center">
        <span className="text-4xl font-bold leading-none tabular-nums text-slate-900 dark:text-navy-50">
          {formatNumber(net)}
        </span>
        <span className="mt-1 text-xs font-medium text-slate-400 dark:text-navy-300">
          / {formatNumber(target)} kcal
        </span>
        <span
          className={`mt-2 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            over
              ? "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
              : "bg-accent/10 text-accent dark:bg-accent-light/15 dark:text-accent-light"
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

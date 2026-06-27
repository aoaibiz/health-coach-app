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
        className="-rotate-90 drop-shadow-[0_4px_12px_rgba(31,157,143,0.25)]"
        aria-hidden
      >
        <defs>
          {/* Gradient progress arc — depth + a premium "energy" feel vs a flat
              single colour. Two stops in the accent family (or amber when over). */}
          <linearGradient id="calorie-ring-grad" x1="0" y1="0" x2="1" y2="1">
            {over ? (
              <>
                <stop offset="0%" stopColor="#fbbf24" />
                <stop offset="100%" stopColor="#f59e0b" />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor="#2db3a3" />
                <stop offset="100%" stopColor="#157a6f" />
              </>
            )}
          </linearGradient>
        </defs>
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
          stroke="url(#calorie-ring-grad)"
          strokeDasharray={`${dash} ${circumference}`}
          className="transition-[stroke-dasharray] duration-700 ease-spring"
        />
      </svg>

      <div className="absolute flex flex-col items-center">
        <span className="bg-gradient-to-b from-slate-900 to-slate-600 bg-clip-text text-[2.6rem] font-bold leading-none tabular-nums text-transparent dark:from-navy-50 dark:to-navy-200">
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

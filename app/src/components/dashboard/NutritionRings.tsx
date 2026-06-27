"use client";

import { formatNumber } from "@/lib/workout";
import type { IntakeTotals } from "@/lib/intake";
import type { NutritionTargets } from "@/lib/types";

/**
 * 栄養の見える化 (AIプランナー 第3陣D — ③). An Apple-Watch-style ring panel: one ring
 * per metric (カロリー + P/F/C) showing today's EATEN intake vs target, with the
 * remaining amount ("あと◯g") read at a glance. Pure SVG (no chart library) to keep
 * the bundle small, mirroring CalorieRing's design.
 *
 * ANTI-FABRICATION: every number is the REAL grounded total (sumIntake, which
 * already excludes not-yet-eaten plans) vs the deterministic target (calcTargets).
 * This component computes nothing nutritional — it only renders ratios.
 */

interface Props {
  intake: IntakeTotals;
  targets: NutritionTargets;
}

interface RingDef {
  key: string;
  label: string;
  current: number;
  target: number;
  unit: string;
  /** Ring stroke color (the accent family per metric). */
  color: string;
}

/** One compact SVG progress ring with the remaining amount in its center. */
function Ring({ ring }: { ring: RingDef }) {
  const size = 92;
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = ring.target > 0 ? ring.current / ring.target : 0;
  const pct = Math.max(0, Math.min(1, ratio));
  const dash = circumference * pct;
  const remaining = ring.target - ring.current;
  const over = remaining < 0;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative flex items-center justify-center">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          aria-hidden
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className="stroke-slate-100 dark:stroke-navy-800"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            stroke={over ? "#f59e0b" : ring.color}
            strokeDasharray={`${dash} ${circumference}`}
            className="transition-[stroke-dasharray] duration-700 ease-spring"
          />
        </svg>
        <div className="absolute flex flex-col items-center leading-none">
          <span className="text-[15px] font-bold tabular-nums text-slate-800 dark:text-navy-50">
            {formatNumber(ring.current)}
          </span>
          <span className="mt-0.5 text-[9px] text-slate-400 dark:text-navy-400">
            /{formatNumber(ring.target)}
          </span>
        </div>
      </div>
      <span className="text-xs font-medium text-slate-600 dark:text-navy-200">{ring.label}</span>
      <span
        className={`text-[11px] tabular-nums ${
          over
            ? "font-semibold text-amber-600 dark:text-amber-400"
            : "text-slate-400 dark:text-navy-400"
        }`}
      >
        {over
          ? `+${formatNumber(Math.abs(remaining))}${ring.unit}`
          : `あと${formatNumber(remaining)}${ring.unit}`}
      </span>
    </div>
  );
}

export function NutritionRings({ intake, targets }: Props) {
  const rings: RingDef[] = [
    {
      key: "kcal",
      label: "カロリー",
      current: intake.calories,
      target: targets.calories,
      unit: "kcal",
      color: "#1f9d8f", // accent (teal)
    },
    {
      key: "p",
      label: "タンパク質",
      current: intake.proteinG,
      target: targets.proteinG,
      unit: "g",
      color: "#fb7185", // rose-400
    },
    {
      key: "f",
      label: "脂質",
      current: intake.fatG,
      target: targets.fatG,
      unit: "g",
      color: "#fbbf24", // amber-400
    },
    {
      key: "c",
      label: "炭水化物",
      current: intake.carbG,
      target: targets.carbG,
      unit: "g",
      color: "#38bdf8", // sky-400
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {rings.map((ring) => (
        <Ring key={ring.key} ring={ring} />
      ))}
    </div>
  );
}

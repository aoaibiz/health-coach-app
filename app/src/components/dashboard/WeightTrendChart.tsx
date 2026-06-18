"use client";

import { useId, useMemo } from "react";
import { buildBarGeometry, type WeightEntry } from "@/lib/weightLog";
import { formatDateLabel } from "@/lib/date";

interface Props {
  entries: WeightEntry[];
  targetKg?: number | null;
}

/** kg with up to 1 decimal, trailing .0 trimmed (e.g. 79.4 / 80). */
function kg(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString("ja-JP", {
    maximumFractionDigits: 1,
  });
}

/** M/D from a YYYY-MM-DD key, for the compact X-axis ticks. */
function shortDate(key: string): string {
  const [, m, d] = key.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/**
 * 体重の推移グラフ — a pure-SVG BAR chart of logged weight over time, with a
 * dashed 目標ライン overlay and the latest bar highlighted + labeled. No chart
 * library (matches the dashboard ring/bars, which are also hand-rolled SVG).
 * Mobile-first, on-theme (accent/teal bars on a white/navy surface).
 *
 * Reads well with few points: 1 entry → one nice centered bar (never a lonely
 * dot); 2–3 → evenly spaced bars. The caller renders the empty (0 entries)
 * state, so this is only mounted with ≥1 entry.
 */
export function WeightTrendChart({ entries, targetKg }: Props) {
  const width = 320;
  const height = 168;
  const padX = 16;
  // Extra headroom up top for the latest-value label; room below for date ticks.
  const padTop = 22;
  const padBottom = 22;

  const uid = useId().replace(/:/g, "");
  const gradId = `wt-bar-${uid}`;
  const gradHotId = `wt-bar-hot-${uid}`;

  const geom = useMemo(
    () =>
      buildBarGeometry(entries, targetKg ?? null, {
        width,
        height,
        padX,
        // Asymmetric vertical padding via padY isn't supported by the layout,
        // so we model top/bottom headroom by shrinking the usable band: use the
        // larger of the two as padY and nudge with transforms below. Simpler:
        // pass padY = max(top,bottom) and let labels live in the safe margins.
        padY: Math.max(padTop, padBottom),
      }),
    [entries, targetKg],
  );

  const { bars, targetY, baselineY, minKg, maxKg } = geom;
  const last = bars[bars.length - 1];
  const first = bars[0];

  // Bar corner radius — capped so short bars still look rounded, not pill-y.
  const radiusFor = (h: number) => Math.min(6, h / 2, 6);

  // Trend direction across the logged window (first → last), for the a11y label
  // and a tiny inline cue.
  const trend =
    bars.length >= 2
      ? last.entry.weightKg < first.entry.weightKg
        ? "down"
        : last.entry.weightKg > first.entry.weightKg
          ? "up"
          : "flat"
      : "flat";

  const ariaLabel = `体重の推移グラフ。${bars.length}件の記録、最新 ${kg(
    last.entry.weightKg,
  )}kg${targetKg != null ? `、目標 ${kg(targetKg)}kg` : ""}。`;

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          {/* Calm teal gradient for the resting bars. */}
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2db3a3" />
            <stop offset="100%" stopColor="#1f9d8f" />
          </linearGradient>
          {/* Brighter gradient for the latest/current bar. */}
          <linearGradient id={gradHotId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3fd0bf" />
            <stop offset="100%" stopColor="#1f9d8f" />
          </linearGradient>
        </defs>

        {/* baseline */}
        <line
          x1={padX}
          y1={baselineY}
          x2={width - padX}
          y2={baselineY}
          className="stroke-slate-200 dark:stroke-navy-700"
          strokeWidth={1}
        />

        {/* bars */}
        {bars.map((b) => {
          const isLast = b.entry.date === last.entry.date;
          const r = radiusFor(b.height);
          return (
            <g key={b.entry.date}>
              <rect
                x={b.x}
                y={b.y}
                width={b.width}
                height={b.height}
                rx={r}
                ry={r}
                fill={isLast ? `url(#${gradHotId})` : `url(#${gradId})`}
                className={isLast ? "" : "opacity-80 dark:opacity-90"}
              />
              {/* X tick: date under each bar (kept compact). */}
              <text
                x={b.cx}
                y={height - 6}
                textAnchor="middle"
                className="fill-slate-400 dark:fill-navy-400"
                fontSize={9}
              >
                {shortDate(b.entry.date)}
              </text>
            </g>
          );
        })}

        {/* latest value label, floating just above the latest bar */}
        <text
          x={last.cx}
          y={Math.max(12, last.y - 6)}
          textAnchor="middle"
          className="fill-accent font-semibold dark:fill-accent-light"
          fontSize={12}
        >
          {kg(last.entry.weightKg)}
          <tspan fontSize={9} dx={1}>
            kg
          </tspan>
        </text>

        {/* 目標ライン — dashed horizontal target line + label */}
        {targetY != null && (
          <g>
            <line
              x1={padX}
              y1={targetY}
              x2={width - padX}
              y2={targetY}
              className="stroke-amber-400 dark:stroke-amber-500"
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            <text
              x={width - padX}
              y={targetY - 4}
              textAnchor="end"
              className="fill-amber-500 font-medium dark:fill-amber-400"
              fontSize={10}
            >
              目標 {kg(targetKg!)}kg
            </text>
          </g>
        )}
      </svg>

      {/* axis hints: weight range + date span + trend cue */}
      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-slate-400 dark:text-navy-400">
        <span>
          {kg(minKg)}–{kg(maxKg)} kg
        </span>
        <span className="flex items-center gap-1">
          {formatDateLabel(first.entry.date)}
          {bars.length > 1 && (
            <>
              {` 〜 ${formatDateLabel(last.entry.date)}`}
              <span
                aria-hidden
                className={
                  trend === "down"
                    ? "text-accent dark:text-accent-light"
                    : trend === "up"
                      ? "text-orange-500"
                      : "text-slate-400"
                }
              >
                {trend === "down" ? "▼" : trend === "up" ? "▲" : "—"}
              </span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

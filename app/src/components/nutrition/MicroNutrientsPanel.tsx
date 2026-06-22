"use client";

// Shared, collapsible vitamin/mineral panel (拡張①「ビタミン・ミネラルまで網羅」).
//
// Renders a Micros bag (functions/_lib/micros.ts) grouped into ビタミン群 / ミネラル群.
// There are many (18), so it's collapsed by default behind a native <details>
// (keyboard-accessible, works on PC + mobile with no JS). A null/absent value is
// shown as "—" (the nutrient wasn't measured for the matched/estimated food) —
// NEVER a fabricated 0. The whole panel is omitted by the caller when the bag has
// no real figure at all (hasAnyMicro).
//
// Used by both the meal card and the dashboard so the grouping/labels/units never
// drift between screens.

import { MICRO_DEFS, hasAnyMicro, type Micros } from "../../../functions/_lib/micros";

const VITAMINS = MICRO_DEFS.filter((d) => d.group === "vitamin");
const MINERALS = MICRO_DEFS.filter((d) => d.group === "mineral");

/**
 * Format a micro amount with ADAPTIVE precision — many vitamins are sub-1mg
 * (B1 0.11mg, B6 0.14mg), so whole-number rounding (formatNumber) would dishonestly
 * read as "0mg". Keep up to 2 decimals for small values, whole numbers for large.
 */
function formatMicro(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const s = value.toFixed(digits);
  // Trim trailing zeros (0.20 → 0.2, 49.0 → 49) for a clean display.
  return digits > 0 ? s.replace(/\.?0+$/, "") : s;
}

/** Render one micro value: "0.11mg" when a real number, else an honest "—". */
function microText(value: number | null | undefined, unit: string): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${formatMicro(value)}${unit}`
    : "—";
}

function MicroGrid({ title, defs, micros }: { title: string; defs: typeof MICRO_DEFS; micros: Micros }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold text-slate-500 dark:text-navy-300">
        {title}
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {defs.map((d) => (
          <div
            key={d.key}
            className="flex items-baseline justify-between gap-2 border-b border-slate-100 pb-1 dark:border-navy-800"
          >
            <span className="text-[11px] text-slate-400 dark:text-navy-400">{d.label}</span>
            <span className="text-xs font-medium tabular-nums text-slate-700 dark:text-navy-100">
              {microText(micros[d.key], d.unit)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A collapsible vitamins+minerals panel. Returns null when the bag carries no
 * real figure (the caller can also guard with hasAnyMicro). `summary` overrides
 * the disclosure label; `defaultOpen` opens it on mount (dashboard uses closed).
 */
export function MicroNutrientsPanel({
  micros,
  summary = "ビタミン・ミネラル",
  defaultOpen = false,
  className = "",
}: {
  micros: Micros | undefined | null;
  summary?: string;
  defaultOpen?: boolean;
  className?: string;
}) {
  if (!hasAnyMicro(micros)) return null;
  const m = micros as Micros;
  return (
    <details open={defaultOpen} className={`group ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] font-semibold text-slate-500 transition-colors hover:text-slate-700 dark:text-navy-300 dark:hover:text-navy-100">
        <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
        {summary}
      </summary>
      <div className="mt-2 space-y-3">
        <MicroGrid title="ビタミン群" defs={VITAMINS} micros={m} />
        <MicroGrid title="ミネラル群" defs={MINERALS} micros={m} />
        <p className="text-[10px] leading-relaxed text-slate-400 dark:text-navy-400">
          データの無い栄養素は「—」と表示します（推測で0は入れません）。
        </p>
      </div>
    </details>
  );
}

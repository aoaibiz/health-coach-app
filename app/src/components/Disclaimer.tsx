"use client";

import { InfoIcon } from "./icons";

/**
 * Cross-cutting transparency note (PRD §10/F8): every calculated number is an
 * estimate and the app is not medical advice. Kept subtle so it doesn't shout,
 * but always present where numbers appear.
 */
export function Disclaimer({ className = "" }: { className?: string }) {
  return (
    <p
      className={`flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-400 dark:text-navy-400 ${className}`}
    >
      <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        数値はすべて計算式に基づく推定です。医療アドバイスではありません。
      </span>
    </p>
  );
}

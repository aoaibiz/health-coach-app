"use client";

import { formatTime } from "@/lib/date";
import { formatNumber } from "@/lib/workout";
import type { Meal } from "@/lib/types";
import { PhotoImage } from "../PhotoImage";
import { MicroNutrientsPanel } from "../nutrition/MicroNutrientsPanel";
import { PencilIcon, TrashIcon } from "../icons";

interface Props {
  meal: Meal;
  onEdit: () => void;
  onDelete: () => void;
}

const CONFIDENCE_JP: Record<string, string> = { low: "低", medium: "中", high: "高" };

/** Per-source badge: label + colour. Makes 確定(公式DB) vs 推定 unmistakable. */
const SOURCE_BADGE: Record<
  NonNullable<Meal["nutrition"]>["sourceKind"] & string,
  { label: string; className: string }
> = {
  db: {
    label: "公式DB",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  label: {
    label: "ラベル値",
    className: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  },
  estimate: {
    label: "推定値・参考",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  },
};

const TYPE_STYLES: Record<string, string> = {
  朝: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  昼: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  夕: "bg-indigo-100 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300",
  間食: "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
};

export function MealCard({ meal, onEdit, onDelete }: Props) {
  return (
    <div className="surface overflow-hidden">
      {meal.photoId && (
        <PhotoImage
          photoId={meal.photoId}
          alt={meal.text || "食事の写真"}
          className="h-44 w-full object-cover"
        />
      )}
      <div className="p-4">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${TYPE_STYLES[meal.type]}`}
            >
              {meal.type}
            </span>
            <span className="text-xs font-medium text-slate-400 dark:text-navy-300">
              {formatTime(meal.timestamp)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onEdit}
              aria-label="編集"
              className="btn-ghost px-2 py-1.5"
            >
              <PencilIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label="削除"
              className="btn-ghost px-2 py-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        {meal.text && (
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700 dark:text-navy-100">
            {meal.text}
          </p>
        )}

        {meal.nutrition && hasNutrition(meal.nutrition) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {meal.nutrition.sourceKind && SOURCE_BADGE[meal.nutrition.sourceKind] && (
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${SOURCE_BADGE[meal.nutrition.sourceKind].className}`}
              >
                {SOURCE_BADGE[meal.nutrition.sourceKind].label}
              </span>
            )}
            {meal.nutrition.items && meal.nutrition.items.length > 0 && (
              <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs text-slate-400 dark:bg-navy-800/60 dark:text-navy-400">
                {meal.nutrition.items.length}品目
              </span>
            )}
            {meal.nutrition.calories != null && (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-700 dark:bg-navy-800 dark:text-navy-100">
                {formatNumber(meal.nutrition.calories)} kcal
              </span>
            )}
            {meal.nutrition.proteinG != null && (
              <MacroTag label="P" value={meal.nutrition.proteinG} className="text-rose-500" />
            )}
            {meal.nutrition.fatG != null && (
              <MacroTag label="F" value={meal.nutrition.fatG} className="text-amber-500" />
            )}
            {meal.nutrition.carbG != null && (
              <MacroTag label="C" value={meal.nutrition.carbG} className="text-sky-500" />
            )}
            {/* Extra nutrients (「全栄養素を出す」) — only shown when a real figure
                exists (null/absent → omitted, never a fabricated 0 / "—"). */}
            {meal.nutrition.fiberG != null && (
              <NutTag label="食物繊維" value={meal.nutrition.fiberG} unit="g" />
            )}
            {meal.nutrition.sugarG != null && (
              <NutTag label="糖質" value={meal.nutrition.sugarG} unit="g" />
            )}
            {meal.nutrition.sodiumMg != null && (
              <NutTag label="塩分(Na)" value={meal.nutrition.sodiumMg} unit="mg" />
            )}
            {meal.nutrition.saturatedFatG != null && (
              <NutTag label="飽和脂肪" value={meal.nutrition.saturatedFatG} unit="g" />
            )}
          </div>
        )}

        {/* Vitamins/minerals (拡張①) — collapsed by default (many), grouped into
            ビタミン群/ミネラル群. Hidden entirely when no real figure exists. */}
        {meal.nutrition?.micros && (
          <MicroNutrientsPanel micros={meal.nutrition.micros} className="mt-2.5" />
        )}

        {/* When the total includes a 推定/ラベル value, say so unmistakably. */}
        {meal.nutrition?.estimated && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
            ※AIの推定です。正確ではありません。
          </p>
        )}

        {meal.nutrition?.source && (
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400 dark:text-navy-400">
            {meal.nutrition.estimated ? "推定を含む" : "出典"}（{meal.nutrition.source}）
            {meal.nutrition.confidence && ` ・ 確信度 ${CONFIDENCE_JP[meal.nutrition.confidence]}`}
          </p>
        )}
      </div>
    </div>
  );
}

function hasNutrition(n: NonNullable<Meal["nutrition"]>): boolean {
  return Object.values(n).some((v) => v != null);
}

function MacroTag({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs tabular-nums text-slate-500 dark:bg-navy-800/60 dark:text-navy-300">
      <span className={`font-bold ${className}`}>{label}</span> {formatNumber(value)}g
    </span>
  );
}

/** A compact tag for an extra nutrient (食物繊維/糖質/塩分/飽和脂肪). Only rendered
 *  by the caller when a real value exists — never for null/unknown. */
function NutTag({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs tabular-nums text-slate-400 dark:bg-navy-800/60 dark:text-navy-400">
      {label} {formatNumber(value)}
      {unit}
    </span>
  );
}

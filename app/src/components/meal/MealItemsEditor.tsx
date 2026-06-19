"use client";

import { useRef, useState } from "react";
import type { MealItem } from "@/lib/types";
import {
  itemsToNutrition,
  presetsForName,
  setItemGrams,
  setItemQty,
} from "@/lib/mealItems";
import { groundManualItem } from "@/lib/foodGrounding";
import { estimateSingleItem, hasApiKey } from "@/lib/analyzeMeal";
import { makeId } from "@/lib/date";
import { formatNumber } from "@/lib/workout";
import { TrashIcon } from "../icons";

/** Per-source badge styling — keeps 公式DB / ラベル値 / 推定値 unmistakable. */
const SOURCE_BADGE: Record<MealItem["sourceKind"], { label: string; className: string }> = {
  db: {
    label: "公式DB",
    className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  label: {
    label: "ラベル値",
    className: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  },
  estimate: {
    label: "推定値・参考",
    className: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  },
};

interface Props {
  items: MealItem[];
  /** Called with the next item list whenever the user edits/adds/removes. */
  onChange: (next: MealItem[]) => void;
}

/**
 * Editable per-item meal breakdown (Phase 4 — MEAL granularity). Each item gets
 * an editable per-unit grams field, a ×qty stepper, optional portion presets,
 * and a delete. The numbers recompute live (db from DB per-100g, label/estimate
 * proportionally) and the running total below mirrors itemsToNutrition.
 */
export function MealItemsEditor({ items, onChange }: Props) {
  const [newName, setNewName] = useState("");
  const [newGrams, setNewGrams] = useState("");
  // Ids of rows whose honest AI estimate is in flight (DB-miss auto-estimate).
  // Drives a per-row "推定中…" indicator; never blocks the editor.
  const [estimating, setEstimating] = useState<Set<string>>(new Set());

  // Always patch the async estimate against the CURRENT item list (the user may
  // have edited/removed rows while the estimate was in flight), so we read items
  // through a ref rather than closing over a stale array.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const totals = itemsToNutrition(items);

  function markEstimating(id: string, on: boolean) {
    setEstimating((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function update(id: string, next: MealItem) {
    onChange(items.map((it) => (it.id === id ? next : it)));
  }
  function remove(id: string) {
    onChange(items.filter((it) => it.id !== id));
  }

  /**
   * For a manually-added row the DB could not match (an honest 推定値 row with no
   * number), fetch a real labelled AI estimate in the BACKGROUND and patch the
   * row's kcal/PFC in — turning the old 0 kcal / "取得できませんでした" dead-end into
   * an honest, editable 推定値. Anti-fabrication is preserved: the estimate is
   * produced by the shared grounded analysis path and stays labelled 推定値 (never
   * 公式DB). Silent no-op when offline / no access key / the model declines.
   */
  async function autoEstimate(id: string, name: string, grams: number) {
    if (!hasApiKey()) return;
    markEstimating(id, true);
    try {
      const filled = await estimateSingleItem(id, name, grams);
      if (!filled) return;
      // Only apply if the row still exists and hasn't already been given a number
      // (e.g. the user typed one in meanwhile). Patch against the live list.
      const current = itemsRef.current;
      const row = current.find((it) => it.id === id);
      if (!row || row.kcal != null) return;
      onChange(current.map((it) => (it.id === id ? filled : it)));
    } finally {
      markEstimating(id, false);
    }
  }

  function add() {
    const name = newName.trim();
    const grams = Number(newGrams);
    if (!name || !Number.isFinite(grams) || grams <= 0) return;
    const item = groundManualItem(makeId(), name, grams);
    // Show the honest row immediately (never block the UI), then — if it's an
    // unmatched estimate with no number — fill it via the background estimate.
    onChange([...items, item]);
    setNewName("");
    setNewGrams("");
    if (item.sourceKind === "estimate" && item.kcal == null) {
      void autoEstimate(item.id, name, grams);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-slate-200 p-3 dark:border-navy-700">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-navy-100">
          品目ごとの内訳
        </span>
        <span className="text-[11px] text-slate-400 dark:text-navy-400">
          量を変えると自動で再計算
        </span>
      </div>

      <ul className="space-y-2.5">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            estimating={estimating.has(item.id)}
            onChange={(next) => update(item.id, next)}
            onRemove={() => remove(item.id)}
          />
        ))}
        {items.length === 0 && (
          <li className="py-2 text-center text-[12px] text-slate-400 dark:text-navy-400">
            品目がありません。下から追加できます。
          </li>
        )}
      </ul>

      {/* Manual add — grounds against the DB exactly like analysis. */}
      <div className="mt-3 flex items-end gap-2 border-t border-slate-100 pt-3 dark:border-navy-800">
        <label className="flex-1">
          <span className="mb-1 block text-[11px] font-medium text-slate-400 dark:text-navy-300">
            品目を追加
          </span>
          <input
            type="text"
            value={newName}
            placeholder="例: ごはん"
            onChange={(e) => setNewName(e.target.value)}
            className="field py-2 text-sm"
          />
        </label>
        <label className="w-24">
          <span className="mb-1 block text-[11px] font-medium text-slate-400 dark:text-navy-300">
            g
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            value={newGrams}
            placeholder="150"
            onChange={(e) => setNewGrams(e.target.value)}
            className="field py-2 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={add}
          disabled={!newName.trim() || !(Number(newGrams) > 0)}
          className="btn-ghost shrink-0 border border-accent/30 px-3 py-2 text-sm text-accent disabled:opacity-40 dark:border-accent-light/30 dark:text-accent-light"
        >
          ＋ 追加
        </button>
      </div>

      {/* Live meal total. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3 dark:border-navy-800">
        <span className="text-[11px] font-semibold text-slate-500 dark:text-navy-300">合計</span>
        {totals.calories != null && (
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-700 dark:bg-navy-800 dark:text-navy-100">
            {formatNumber(totals.calories)} kcal
          </span>
        )}
        {totals.proteinG != null && (
          <Macro label="P" value={totals.proteinG} className="text-rose-500" />
        )}
        {totals.fatG != null && <Macro label="F" value={totals.fatG} className="text-amber-500" />}
        {totals.carbG != null && <Macro label="C" value={totals.carbG} className="text-sky-500" />}
      </div>
      {totals.estimated && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          ※推定/ラベル値を含みます。正確ではありません。
        </p>
      )}
    </div>
  );
}

function ItemRow({
  item,
  estimating,
  onChange,
  onRemove,
}: {
  item: MealItem;
  /** True while a background AI estimate for this DB-miss row is in flight. */
  estimating: boolean;
  onChange: (next: MealItem) => void;
  onRemove: () => void;
}) {
  const badge = SOURCE_BADGE[item.sourceKind];
  const presets = presetsForName(item.name);

  return (
    <li className="rounded-lg bg-slate-50 p-2.5 dark:bg-navy-800/50">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-slate-700 dark:text-navy-100">
              {item.name}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.className}`}>
              {badge.label}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label="品目を削除"
          className="btn-ghost shrink-0 px-1.5 py-1 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-end gap-2">
        <label className="w-28">
          <span className="mb-0.5 block text-[10px] text-slate-400 dark:text-navy-400">
            1単位の量
          </span>
          <div className="relative">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={item.grams}
              onChange={(e) => onChange(setItemGrams(item, Number(e.target.value)))}
              className="field py-1.5 pr-7 text-sm"
              aria-label={`${item.name} のグラム`}
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400 dark:text-navy-400">
              g
            </span>
          </div>
        </label>

        {/* ×qty stepper */}
        <div>
          <span className="mb-0.5 block text-[10px] text-slate-400 dark:text-navy-400">数量</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onChange(setItemQty(item, item.qty - 1))}
              aria-label="数量を減らす"
              className="btn-ghost h-8 w-8 justify-center p-0 text-slate-500 dark:text-navy-300"
            >
              −
            </button>
            <span className="w-8 text-center text-sm font-semibold tabular-nums">×{item.qty}</span>
            <button
              type="button"
              onClick={() => onChange(setItemQty(item, item.qty + 1))}
              aria-label="数量を増やす"
              className="btn-ghost h-8 w-8 justify-center p-0 text-slate-500 dark:text-navy-300"
            >
              ＋
            </button>
          </div>
        </div>

        {/* Per-item computed numbers (or the in-flight estimate indicator). */}
        <div className="flex-1 text-right">
          {item.kcal != null ? (
            <span className="text-sm font-semibold tabular-nums text-slate-700 dark:text-navy-100">
              {formatNumber(item.kcal)} kcal
            </span>
          ) : estimating ? (
            <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
              推定中…
            </span>
          ) : (
            <span className="text-sm font-semibold tabular-nums text-slate-700 dark:text-navy-100">
              —
            </span>
          )}
        </div>
      </div>

      {presets.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange(setItemGrams(item, p.grams))}
              className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500 transition active:scale-95 hover:bg-slate-100 dark:border-navy-700 dark:text-navy-300 dark:hover:bg-navy-800"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function Macro({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <span className="rounded-md bg-slate-50 px-2 py-0.5 text-xs tabular-nums text-slate-500 dark:bg-navy-800/60 dark:text-navy-300">
      <span className={`font-bold ${className}`}>{label}</span> {formatNumber(value)}g
    </span>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  latestEntry,
  loadWeightLog,
  logWeight,
  remainingToTarget,
  type WeightEntry,
} from "@/lib/weightLog";
import { toDateKey } from "@/lib/date";
import { WeightTrendChart } from "@/components/dashboard/WeightTrendChart";
import { ChartIcon } from "@/components/icons";

interface Props {
  /** Target weight from the profile, if the owner has set one. */
  targetWeightKg?: number;
}

/** kg with up to 1 decimal, trailing .0 trimmed (e.g. 79.4 / 80). */
function kg(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString("ja-JP", {
    maximumFractionDigits: 1,
  });
}

/**
 * 成果ホームの体重トラッキング: 今日の体重をワンタップで記録（保存→即反映）、
 * 現在体重・目標体重・目標まであと何kg、そして体重の推移グラフ（目標ライン付き）。
 * すべてローカル（localStorage）。バックエンドなし。
 */
export function WeightSection({ targetWeightKg }: Props) {
  const [entries, setEntries] = useState<WeightEntry[]>([]);
  const [input, setInput] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  // Load the weight log, and re-read it whenever the user returns to this tab
  // (focus) or another tab edits localStorage (storage). This is the "全ページ連動"
  // path: logging weight on a different view/tab and coming back reflects here
  // without a hard reload — mirrors the hasKey listener in useChat/MealEditor.
  useEffect(() => {
    setEntries(loadWeightLog());
    const refresh = () => setEntries(loadWeightLog());
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const today = toDateKey();
  const latest = useMemo(() => latestEntry(entries), [entries]);
  const todayEntry = useMemo(
    () => entries.find((e) => e.date === today) ?? null,
    [entries, today],
  );
  const remaining = useMemo(
    () => remainingToTarget(latest?.weightKg ?? null, targetWeightKg ?? null),
    [latest, targetWeightKg],
  );

  // Prefill the field with today's value (so re-entering edits it).
  useEffect(() => {
    if (todayEntry) setInput(String(todayEntry.weightKg));
  }, [todayEntry]);

  const parsed = Number(input);
  const valid = input.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && parsed < 500;

  function handleSave() {
    if (!valid) return;
    const next = logWeight(parsed); // upsert today's entry → persist
    setEntries(next);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1600);
  }

  return (
    <section className="surface space-y-4 p-5">
      <h2 className="flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-navy-100">
        <ChartIcon className="h-4 w-4" /> 体重
      </h2>

      {/* 現在体重 / 目標体重 / 目標まであと何kg */}
      <div className="grid grid-cols-3 divide-x divide-slate-100 text-center dark:divide-navy-800">
        <Metric
          label="現在体重"
          value={latest ? `${kg(latest.weightKg)}` : "—"}
          unit={latest ? "kg" : ""}
          accent="text-slate-800 dark:text-navy-50"
        />
        <Metric
          label="目標体重"
          value={targetWeightKg != null ? `${kg(targetWeightKg)}` : "—"}
          unit={targetWeightKg != null ? "kg" : ""}
          accent="text-accent dark:text-accent-light"
        />
        <Metric
          label="目標まで"
          value={
            remaining
              ? remaining.direction === "reached"
                ? "達成"
                : `${kg(remaining.abs)}`
              : "—"
          }
          unit={remaining && remaining.direction !== "reached" ? "kg" : ""}
          accent={
            remaining && remaining.direction === "reached"
              ? "text-accent dark:text-accent-light"
              : "text-slate-800 dark:text-navy-50"
          }
          hint={
            remaining && remaining.direction === "lose"
              ? "あと減らす"
              : remaining && remaining.direction === "gain"
                ? "あと増やす"
                : undefined
          }
        />
      </div>

      {/* 今日の体重を入力 — one-tap entry */}
      <div>
        <label className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-navy-100">
          今日の体重を入力
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setJustSaved(false);
              }}
              placeholder={latest ? String(latest.weightKg) : "65.0"}
              className="field pr-10"
              aria-label="今日の体重 (kg)"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 dark:text-navy-400">
              kg
            </span>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={!valid}
            className="btn-primary shrink-0 px-5"
          >
            {justSaved ? "保存 ✓" : todayEntry ? "更新" : "記録"}
          </button>
        </div>
        {todayEntry && !justSaved && (
          <p className="mt-1 text-xs text-slate-400 dark:text-navy-400">
            今日はすでに {kg(todayEntry.weightKg)} kg で記録済み（上書きできます）
          </p>
        )}
      </div>

      {/* 体重の推移グラフ (目標ライン付き) */}
      {entries.length > 0 ? (
        <div>
          <WeightTrendChart entries={entries} targetKg={targetWeightKg ?? null} />
          {targetWeightKg == null && (
            <p className="mt-2 text-xs text-slate-400 dark:text-navy-400">
              <Link
                href="/profile"
                className="font-medium text-accent underline dark:text-accent-light"
              >
                プロフィールで目標体重を設定
              </Link>
              すると、グラフに目標ラインが表示されます。
            </p>
          )}
        </div>
      ) : (
        <p className="rounded-lg bg-slate-50 px-3 py-3 text-xs leading-relaxed text-slate-400 dark:bg-navy-800/60 dark:text-navy-400">
          今日の体重を記録すると、ここに推移グラフが表示されます。
          {targetWeightKg == null && (
            <>
              {" "}
              <Link
                href="/profile"
                className="font-medium text-accent underline dark:text-accent-light"
              >
                目標体重
              </Link>
              を設定すると目標ラインも引かれます。
            </>
          )}
        </p>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  unit,
  accent,
  hint,
}: {
  label: string;
  value: string;
  unit: string;
  accent: string;
  hint?: string;
}) {
  return (
    <div className="px-1">
      <p className="text-xs text-slate-400 dark:text-navy-400">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${accent}`}>
        {value}
        {unit && <span className="ml-0.5 text-xs font-normal text-slate-400">{unit}</span>}
      </p>
      {hint && <p className="text-[10px] text-slate-400 dark:text-navy-400">{hint}</p>}
    </div>
  );
}

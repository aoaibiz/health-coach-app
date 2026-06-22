"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { DateSwitcher } from "@/components/DateSwitcher";
import { useSelectedDate } from "@/components/SelectedDateProvider";
import { useSleep } from "@/components/sleep/useSleep";
import { MoonIcon } from "@/components/icons";
import { formatDuration, isValidTime, sleepDurationMin } from "@/lib/sleepLog";

/**
 * 睡眠メニュー — record the selected day's 就寝時刻 / 起床時刻 and show the derived
 * sleep length (overnight-aware). selectedDate-driven (per day), like 食事/筋トレ.
 * The length is calculated, never typed — nothing is fabricated; an incomplete
 * entry shows "—" for the duration.
 */
export default function SleepPage() {
  const { date, setDate } = useSelectedDate();
  const { sleep, ready, save, clear } = useSleep(date);

  const [bedtime, setBedtime] = useState("");
  const [wakeTime, setWakeTime] = useState("");
  const [saved, setSaved] = useState(false);

  // Adopt the saved record for the selected day into the inputs whenever the day
  // (or its stored record) changes — so switching days shows that day's values.
  useEffect(() => {
    setBedtime(sleep?.bedtime ?? "");
    setWakeTime(sleep?.wakeTime ?? "");
    setSaved(false);
  }, [date, sleep?.bedtime, sleep?.wakeTime]);

  // Live preview of the duration as the user types (recomputed, never stored raw).
  const previewMin =
    isValidTime(bedtime) && isValidTime(wakeTime)
      ? sleepDurationMin(bedtime, wakeTime)
      : null;
  const canSave = isValidTime(bedtime) && isValidTime(wakeTime);

  function handleSave() {
    if (!canSave) return;
    save(bedtime, wakeTime);
    setSaved(true);
  }

  function handleClear() {
    clear();
    setBedtime("");
    setWakeTime("");
    setSaved(false);
  }

  return (
    <AppShell>
      <div className="space-y-4">
        <DateSwitcher date={date} onChange={setDate} />

        <section className="surface p-5">
          <h1 className="mb-1 flex items-center gap-2 text-lg font-bold">
            <MoonIcon className="h-5 w-5 text-indigo-400" /> 睡眠
          </h1>
          <p className="mb-4 text-xs leading-relaxed text-slate-500 dark:text-navy-300">
            その日の<strong>寝た時間</strong>と<strong>起きた時間</strong>を入れると、睡眠時間を自動で計算します（日付をまたいでもOK・例: 23:00就寝→7:00起床＝8時間）。
          </p>

          <div className="grid grid-cols-2 gap-3">
            <TimeField
              label="就寝（寝た時間）"
              value={bedtime}
              onChange={(v) => {
                setBedtime(v);
                setSaved(false);
              }}
            />
            <TimeField
              label="起床（起きた時間）"
              value={wakeTime}
              onChange={(v) => {
                setWakeTime(v);
                setSaved(false);
              }}
            />
          </div>

          {/* Derived duration — the headline number. "—" when incomplete. */}
          <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-center dark:bg-navy-800/60">
            <p className="text-[11px] text-slate-400 dark:text-navy-400">睡眠時間（自動計算）</p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums text-slate-800 dark:text-navy-50">
              {previewMin != null ? (
                formatDuration(previewMin)
              ) : (
                <span className="text-slate-300 dark:text-navy-500">—</span>
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="btn-primary mt-4 w-full py-3 disabled:opacity-50"
          >
            {sleep ? "更新する" : "記録する"}
          </button>

          {saved && (
            <p className="mt-2 text-center text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              ✓ 睡眠を記録しました
            </p>
          )}

          {sleep && (
            <button
              type="button"
              onClick={handleClear}
              className="btn-ghost mt-2 w-full justify-center py-2.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
            >
              この日の睡眠記録を削除
            </button>
          )}
        </section>

        {ready && !sleep && (
          <p className="px-1 text-center text-xs text-slate-400 dark:text-navy-400">
            まだこの日の睡眠は記録されていません。
          </p>
        )}
      </div>
    </AppShell>
  );
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-400 dark:text-navy-300">
        {label}
      </span>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="field py-2.5 text-base tabular-nums"
      />
    </label>
  );
}

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
  const [saveError, setSaveError] = useState(false);

  // Adopt the saved record for the selected day into the inputs whenever the day
  // (or its stored record) changes — so switching days shows that day's values.
  useEffect(() => {
    setBedtime(sleep?.bedtime ?? "");
    setWakeTime(sleep?.wakeTime ?? "");
    setSaved(false);
    setSaveError(false);
  }, [date, sleep?.bedtime, sleep?.wakeTime]);

  // Live preview of the duration as the user types (recomputed, never stored raw).
  const previewMin =
    isValidTime(bedtime) && isValidTime(wakeTime)
      ? sleepDurationMin(bedtime, wakeTime)
      : null;
  const canSave = isValidTime(bedtime) && isValidTime(wakeTime);

  function handleSave() {
    if (!canSave) return;
    // Only claim success when the write actually PERSISTED (Codex audit C1): a
    // localStorage failure shows a real error, never a phantom "記録しました".
    const ok = save(bedtime, wakeTime);
    setSaved(ok);
    setSaveError(!ok);
  }

  function handleClear() {
    clear();
    setBedtime("");
    setWakeTime("");
    setSaved(false);
    setSaveError(false);
  }

  return (
    <AppShell>
      <div className="space-y-4">
        {/* Page identity — 睡眠 = rest indigo (service colour). */}
        <header className="flex items-center gap-3">
          <span className="icon-chip bg-indigo-100 text-indigo-500 dark:bg-indigo-400/15 dark:text-indigo-300">
            <MoonIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight">睡眠</h1>
            <p className="text-xs text-slate-500 dark:text-navy-300">
              寝た時間と起きた時間から自動計算します
            </p>
          </div>
        </header>

        <DateSwitcher date={date} onChange={setDate} />

        <section className="surface relative overflow-hidden p-5">
          {/* faint moonlit glow */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-indigo-400/10 blur-3xl"
          />
          <p className="relative mb-4 text-xs leading-relaxed text-slate-500 dark:text-navy-300">
            その日の<strong>寝た時間</strong>と<strong>起きた時間</strong>を入れると、睡眠時間を自動で計算します（日付をまたいでもOK・例: 23:00就寝→7:00起床＝8時間）。
          </p>

          <div className="grid grid-cols-2 gap-3">
            <TimeField
              label="就寝（寝た時間）"
              value={bedtime}
              onChange={(v) => {
                setBedtime(v);
                setSaved(false);
                setSaveError(false);
              }}
            />
            <TimeField
              label="起床（起きた時間）"
              value={wakeTime}
              onChange={(v) => {
                setWakeTime(v);
                setSaved(false);
                setSaveError(false);
              }}
            />
          </div>

          {/* Derived duration — the headline number. "—" when incomplete. */}
          <div className="mt-4 rounded-xl bg-gradient-to-br from-indigo-50 to-slate-50 px-4 py-3.5 text-center dark:from-indigo-400/10 dark:to-navy-800/60">
            <p className="text-[11px] font-medium text-indigo-400/90 dark:text-indigo-300/80">
              睡眠時間（自動計算）
            </p>
            <p className="mt-0.5 text-3xl font-bold tabular-nums tracking-tight text-slate-800 dark:text-navy-50">
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
            <p className="mt-2 animate-pop-in rounded-xl bg-emerald-50 px-3 py-2 text-center text-sm font-semibold text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
              ✓ 睡眠を記録しました
            </p>
          )}

          {saveError && (
            <p className="mt-2 animate-fade-in rounded-xl bg-rose-50 px-3 py-2 text-center text-sm font-semibold text-rose-600 dark:bg-rose-400/10 dark:text-rose-300">
              保存に失敗しました。端末の空き容量を確認して、もう一度お試しください。
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

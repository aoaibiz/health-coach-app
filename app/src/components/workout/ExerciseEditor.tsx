"use client";

import { useState } from "react";
import type { Exercise } from "@/lib/types";
import { isBodyweightName, isCardioName, metForExercise } from "@/lib/burn";
import { makeSet, syncLegacyFields } from "@/lib/workoutSets";
import { makeId } from "@/lib/date";
import { WorkoutSetsEditor } from "./WorkoutSetsEditor";
import { CloseIcon } from "../icons";

interface Props {
  /** When editing, the existing logged exercise; when adding, null. */
  existing: Exercise | null;
  /** Bodyweight (kg) for the live burn estimate; null when no profile yet. */
  bodyweightKg: number | null;
  onClose: () => void;
  onSave: (exercise: Exercise) => void;
}

/** A blank exercise seeded with 3 editable sets (default weight 0, 10 reps). */
function blankExercise(): Exercise {
  return syncLegacyFields(
    {
      id: makeId(),
      name: "",
      sets: 3,
      reps: 10,
      weight: 0,
      // 0 = no time logged: rep-based strength estimates time from reps, so
      // editing reps changes kcal. The user logs minutes for cardio instead.
      durationMin: 0,
      intensity: "moderate",
    },
    [makeSet(makeId(), 0, 10), makeSet(makeId(), 0, 10), makeSet(makeId(), 0, 10)],
  );
}

/**
 * Bottom-sheet editor for one exercise — the WORKOUT mirror of MealEditor.
 * Holds a local draft so edits are committed only on 記録する/保存 (like the meal
 * editor's onSave), then collapses to an ExerciseCard. The body is the existing
 * per-set editor (WorkoutSetsEditor) for strength, or a 時間 stepper for cardio,
 * so per-set granularity / intensity / bodyweight handling are unchanged.
 */
export function ExerciseEditor({ existing, bodyweightKg, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<Exercise>(() => existing ?? blankExercise());

  const cardio = isCardioName(draft.name);
  const named = draft.name.trim() !== "";

  function patch(p: Partial<Exercise>) {
    setDraft((prev) => {
      const next = { ...prev, ...p };
      // When a name resolves to a bodyweight move, clear any stray weight so the
      // draft holds no phantom load — on the scalar field and every per-set entry.
      if ("name" in p && isBodyweightName(next.name)) {
        if (next.weight !== 0) next.weight = 0;
        if (next.setEntries?.some((s) => s.weight !== 0)) {
          next.setEntries = next.setEntries.map((s) => ({ ...s, weight: 0 }));
        }
      }
      return next;
    });
  }

  function handleSave() {
    if (!named) return; // need a name to log, mirroring the meal editor's guard
    onSave(draft);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="閉じる"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm dark:bg-black/60"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="relative max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl dark:bg-navy-900 animate-[slideup_0.22s_ease-out]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold">
            {existing ? "種目を編集" : "種目を記録"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost px-2 py-2"
            aria-label="閉じる"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Name */}
        <input
          type="text"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="種目名（例: ベンチプレス）"
          className="field mb-4 py-2.5"
        />

        {cardio ? (
          // Time-based cardio: a single 時間 stepper drives the burn.
          <div className="rounded-xl border border-slate-200 p-3 dark:border-navy-700">
            <span className="mb-1.5 block text-[11px] font-medium text-slate-400 dark:text-navy-300">
              時間（分）
            </span>
            <div className="flex items-center overflow-hidden rounded-xl border border-slate-200 dark:border-navy-700">
              <button
                type="button"
                aria-label="時間を減らす"
                onClick={() =>
                  patch({ durationMin: Math.max(0, (draft.durationMin ?? 0) - 5) })
                }
                className="h-10 w-10 shrink-0 bg-slate-50 text-lg font-medium text-slate-500 active:bg-slate-100 dark:bg-navy-800 dark:text-navy-200 dark:active:bg-navy-700"
              >
                −
              </button>
              <input
                type="number"
                inputMode="decimal"
                aria-label="時間"
                value={draft.durationMin ?? 0}
                onChange={(e) =>
                  patch({ durationMin: Math.max(0, parseFloat(e.target.value) || 0) })
                }
                className="h-10 w-full min-w-0 bg-transparent text-center text-base font-semibold tabular-nums outline-none"
              />
              <button
                type="button"
                aria-label="時間を増やす"
                onClick={() => patch({ durationMin: (draft.durationMin ?? 0) + 5 })}
                className="h-10 w-10 shrink-0 bg-slate-50 text-lg font-medium text-slate-500 active:bg-slate-100 dark:bg-navy-800 dark:text-navy-200 dark:active:bg-navy-700"
              >
                +
              </button>
            </div>
            {named && (
              <p className="mt-2 text-[11px] text-slate-400 dark:text-navy-400">
                消費カロリー推定 = MET {metForExercise(draft.name)} × 体重 × 時間
              </p>
            )}
          </div>
        ) : (
          // Strength (weighted or bodyweight): per-set weight × reps editor, which
          // shows its own live total + MET/method note + intensity selector.
          <WorkoutSetsEditor
            exercise={draft}
            bodyweightKg={bodyweightKg}
            onChange={(next) => setDraft(next)}
          />
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={!named}
          className="btn-primary mt-4 w-full py-3"
        >
          {existing ? "保存" : "記録する"}
        </button>
        {!named && (
          <p className="mt-2 text-center text-[11px] text-slate-400 dark:text-navy-400">
            種目名を入力すると記録できます
          </p>
        )}
      </div>

      <style>{`@keyframes slideup{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>
    </div>
  );
}

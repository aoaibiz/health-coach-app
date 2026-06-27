"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { DateSwitcher } from "@/components/DateSwitcher";
import { useSelectedDate } from "@/components/SelectedDateProvider";
import { ExerciseCard } from "@/components/workout/ExerciseCard";
import { ExerciseEditor } from "@/components/workout/ExerciseEditor";
import { SummaryPanel } from "@/components/workout/SummaryPanel";
import { useWorkout } from "@/components/workout/useWorkout";
import { useProfile } from "@/components/profile/useProfile";
import { DumbbellIcon, PlusIcon } from "@/components/icons";
import type { Exercise } from "@/lib/types";

export default function WorkoutPage() {
  const { date, setDate } = useSelectedDate();
  const { exercises, prevWorkout, ready, addExercise, updateExercise, removeExercise } =
    useWorkout(date);
  const { profile } = useProfile();

  // null = closed, "new" = adding, Exercise = editing (mirrors meal/page.tsx).
  const [editorState, setEditorState] = useState<"new" | Exercise | null>(null);

  function handleSave(exercise: Exercise) {
    if (editorState === "new") addExercise(exercise);
    else updateExercise(exercise.id, exercise);
    setEditorState(null);
  }

  // 完了 (AIプランナー 第2陣C): flip a PLANNED exercise to done so it starts counting
  // toward 成果/消費kcal. Reuses the existing updateExercise (tombstone-safe sync) —
  // we only change the status, leaving the logged sets/reps/weight untouched.
  function handleComplete(exercise: Exercise) {
    updateExercise(exercise.id, { ...exercise, status: "done" });
  }

  return (
    <AppShell>
      <div className="space-y-4">
        <DateSwitcher date={date} onChange={setDate} />

        <SummaryPanel exercises={exercises} prevWorkout={prevWorkout} profile={profile} />

        {ready && exercises.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3">
            {exercises.map((ex) => (
              <ExerciseCard
                key={ex.id}
                exercise={ex}
                bodyweightKg={profile?.weightKg ?? null}
                onEdit={() => setEditorState(ex)}
                onDelete={() => removeExercise(ex.id)}
                onComplete={
                  ex.status === "planned" ? () => handleComplete(ex) : undefined
                }
              />
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setEditorState("new")}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 py-4 text-sm font-semibold text-accent transition hover:bg-accent/5 active:scale-[0.99] dark:border-navy-700 dark:text-accent-light dark:hover:bg-accent/10"
        >
          <PlusIcon className="h-5 w-5" />
          種目を追加
        </button>
      </div>

      {editorState !== null && (
        <ExerciseEditor
          existing={editorState === "new" ? null : editorState}
          bodyweightKg={profile?.weightKg ?? null}
          onClose={() => setEditorState(null)}
          onSave={handleSave}
        />
      )}
    </AppShell>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-12 text-center dark:border-navy-800">
      <DumbbellIcon className="mb-3 h-10 w-10 text-slate-300 dark:text-navy-600" />
      <p className="text-sm font-medium text-slate-500 dark:text-navy-300">
        今日のトレーニングを記録
      </p>
      <p className="mt-1 text-xs text-slate-400 dark:text-navy-400">
        下の「種目を追加」から記録する
      </p>
    </div>
  );
}

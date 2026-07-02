"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { DateSwitcher } from "@/components/DateSwitcher";
import { useSelectedDate } from "@/components/SelectedDateProvider";
import Link from "next/link";
import { ExerciseCard } from "@/components/workout/ExerciseCard";
import { ExerciseEditor } from "@/components/workout/ExerciseEditor";
import { SummaryPanel } from "@/components/workout/SummaryPanel";
import { useWorkout } from "@/components/workout/useWorkout";
import { useProfile } from "@/components/profile/useProfile";
import { ChevronRightIcon, DumbbellIcon, FlameIcon, PlusIcon } from "@/components/icons";
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
        {/* Page identity — 運動 = power violet (service colour). */}
        <header className="flex items-center gap-3">
          <span className="icon-chip bg-violet-100 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300">
            <DumbbellIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight">運動</h1>
            <p className="text-xs text-slate-500 dark:text-navy-300">
              筋トレの記録と、GPSでの有酸素計測
            </p>
          </div>
        </header>

        <DateSwitcher date={date} onChange={setDate} />

        {/* 有酸素はここから — the GPS tracker keeps its own screen (/cardio);
            this energetic launcher folds it under 運動 so nothing is hidden. */}
        <Link
          href="/cardio"
          className="group flex items-center gap-3.5 overflow-hidden rounded-2xl bg-gradient-to-r from-orange-400 to-orange-500 p-4 text-white shadow-glow-energy transition duration-200 ease-spring hover:-translate-y-0.5 hover:shadow-card-hover active:translate-y-0 active:scale-[0.99]"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm">
            <FlameIcon className="h-6 w-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold">有酸素をGPSで計測</span>
            <span className="block text-xs text-white/85">
              歩き・ラン・自転車 — 距離と消費カロリーを自動記録
            </span>
          </span>
          <ChevronRightIcon className="h-5 w-5 shrink-0 transition-transform duration-200 ease-spring group-hover:translate-x-0.5" />
        </Link>

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
    <div className="flex animate-fade-in-up flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-12 text-center dark:border-navy-800">
      <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent dark:bg-accent-light/15 dark:text-accent-light">
        <DumbbellIcon className="h-7 w-7" />
      </span>
      <p className="text-sm font-semibold text-slate-600 dark:text-navy-200">
        今日のトレーニングを記録
      </p>
      <p className="mt-1 text-xs text-slate-400 dark:text-navy-400">
        下の「種目を追加」から記録する
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DateSwitcher } from "@/components/DateSwitcher";
import { useSelectedDate } from "@/components/SelectedDateProvider";
import { MealCard } from "@/components/meal/MealCard";
import { MealEditor } from "@/components/meal/MealEditor";
import { useMeals } from "@/components/meal/useMeals";
import { useProfile } from "@/components/profile/useProfile";
import { MealIcon, PlusIcon, UserIcon } from "@/components/icons";
import type { Meal } from "@/lib/types";

export default function MealPage() {
  const { date, setDate } = useSelectedDate();
  const { dayMeals, ready, addMeal, updateMeal, removeMeal } = useMeals(date);
  const { profile, ready: profileReady } = useProfile();

  // null = closed, "new" = adding, Meal = editing.
  const [editorState, setEditorState] = useState<"new" | Meal | null>(null);

  function handleSave(meal: Meal) {
    if (editorState === "new") addMeal(meal);
    else updateMeal(meal.id, meal);
    setEditorState(null);
  }

  return (
    <AppShell>
      <div className="space-y-4 pb-24">
        <DateSwitcher date={date} onChange={setDate} />

        {profileReady && !profile && (
          <Link
            href="/profile"
            className="flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-3.5 transition active:scale-[0.99] dark:border-accent-light/30 dark:bg-accent-light/10"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent dark:text-accent-light">
              <UserIcon className="h-5 w-5" />
            </span>
            <span className="flex-1 text-sm">
              <span className="font-semibold text-slate-800 dark:text-navy-50">
                プロフィールを設定
              </span>
              <span className="block text-xs text-slate-500 dark:text-navy-300">
                目標カロリー・PFC を計算します
              </span>
            </span>
            <span className="text-accent dark:text-accent-light" aria-hidden>
              →
            </span>
          </Link>
        )}

        {ready && dayMeals.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-3">
            {dayMeals.map((meal) => (
              <MealCard
                key={meal.id}
                meal={meal}
                onEdit={() => setEditorState(meal)}
                onDelete={() => void removeMeal(meal.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Floating add button */}
      <button
        type="button"
        onClick={() => setEditorState("new")}
        aria-label="食事を追加"
        className="fixed bottom-24 right-1/2 z-20 flex h-14 w-14 translate-x-[calc(min(50vw,14rem)-1.5rem)] items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition active:scale-95 hover:bg-accent-dark"
      >
        <PlusIcon className="h-7 w-7" />
      </button>

      {editorState !== null && (
        <MealEditor
          date={date}
          existing={editorState === "new" ? null : editorState}
          onClose={() => setEditorState(null)}
          onSave={handleSave}
        />
      )}
    </AppShell>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 px-6 py-16 text-center dark:border-navy-800">
      <MealIcon className="mb-3 h-10 w-10 text-slate-300 dark:text-navy-600" />
      <p className="text-sm font-medium text-slate-500 dark:text-navy-300">
        まだ記録がありません
      </p>
      <p className="mt-1 text-xs text-slate-400 dark:text-navy-400">
        右下の ＋ から写真かテキストで記録
      </p>
      <p className="mt-3 max-w-[18rem] text-xs leading-relaxed text-slate-400 dark:text-navy-400">
        記録のあと「<span className="font-semibold text-accent dark:text-accent-light">✨AI解析</span>」を押すと、カロリーと PFC が自動で出ます。
      </p>
    </div>
  );
}

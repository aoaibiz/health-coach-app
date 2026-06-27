"use client";

import { AppShell } from "@/components/AppShell";
import { HistoryView } from "@/components/history/HistoryView";
import { useHistoryData } from "@/components/history/useHistoryData";

/**
 * 履歴・傾向ページ — 過去の食事/筋トレ/体重を「期間で遡って俯瞰」する画面。
 * AIコーチが見ているのと同じ集計（直近7/14/30日の栄養平均・部位別頻度と空白・
 * 種目の伸び・体重推移）を表示するので、コーチの提案と自分のデータが一致する。
 * 日ごとの細かい記録はカレンダーで遡れる（画面下部に導線）。
 */
export default function HistoryPage() {
  const { data, ready } = useHistoryData();

  return (
    <AppShell>
      <div className="space-y-4">
        <header>
          <h1 className="text-xl font-bold tracking-tight">履歴・傾向</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-navy-300">
            過去の記録から、栄養の平均・鍛えた部位・種目の伸びをまとめて振り返れます。
          </p>
        </header>

        {ready && (
          <HistoryView
            summary={data.summary}
            isEmpty={data.isEmpty}
            hasProfile={data.profile != null}
          />
        )}
      </div>
    </AppShell>
  );
}

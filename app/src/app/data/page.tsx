"use client";

import { AppShell } from "@/components/AppShell";
import { DataHub } from "@/components/data/DataHub";

// データ tab — trends (履歴・傾向) + カレンダー merged into one hub. /history and
// /calendar render the same hub with a different initial tab, so old URLs work.
export default function DataPage() {
  return (
    <AppShell>
      <DataHub initial="trends" />
    </AppShell>
  );
}

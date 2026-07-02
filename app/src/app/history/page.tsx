"use client";

import { AppShell } from "@/components/AppShell";
import { DataHub } from "@/components/data/DataHub";

// 履歴・傾向 now lives inside the データ hub (trends tab). This route is kept as
// an alias so existing links/bookmarks keep working.
export default function HistoryPage() {
  return (
    <AppShell>
      <DataHub initial="trends" />
    </AppShell>
  );
}

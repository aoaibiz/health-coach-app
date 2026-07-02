"use client";

import { AppShell } from "@/components/AppShell";
import { DataHub } from "@/components/data/DataHub";

// カレンダー now lives inside the データ hub (calendar tab). This route is kept
// as an alias so existing links/bookmarks keep working.
export default function CalendarPage() {
  return (
    <AppShell>
      <DataHub initial="calendar" />
    </AppShell>
  );
}

"use client";

import { TodayView } from "@/components/today/TodayView";

// /dashboard renders the same 今日 view as the home page (/), kept as an alias
// so existing deep links and post-setup navigation continue to work.
export default function DashboardPage() {
  return <TodayView />;
}

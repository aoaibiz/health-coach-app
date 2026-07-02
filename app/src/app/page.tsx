"use client";

import { TodayView } from "@/components/today/TodayView";

// Home (/) is 今日 — the today-at-a-glance dashboard: calorie hero, next action,
// quick-log tiles, streak, PFC balance, weight. The coach lives at /chat
// (the raised centre tab); every feature is one tap from the bottom bar.
export default function HomePage() {
  return <TodayView />;
}

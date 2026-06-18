"use client";

import { DashboardView } from "@/components/dashboard/DashboardView";

// /dashboard renders the same 成果 view as the home page (/), kept as an alias
// so existing deep links and post-setup navigation continue to work.
export default function DashboardPage() {
  return <DashboardView />;
}

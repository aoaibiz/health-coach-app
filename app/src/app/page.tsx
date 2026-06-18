"use client";

import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/components/chat/ChatView";

// Home (/) is the CHAT — after login the coach conversation is the landing.
// The other pages (成果/食事/筋トレ/カレンダー) are reachable from the nav menu.
export default function HomePage() {
  return (
    <AppShell>
      <ChatView />
    </AppShell>
  );
}

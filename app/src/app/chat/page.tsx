"use client";

import { AppShell } from "@/components/AppShell";
import { ChatView } from "@/components/chat/ChatView";

// /chat renders the coach conversation. It's the same view as the home page (/),
// kept as an explicit route so deep links + the in-app nav highlight work.
export default function ChatPage() {
  return (
    <AppShell>
      <ChatView />
    </AppShell>
  );
}

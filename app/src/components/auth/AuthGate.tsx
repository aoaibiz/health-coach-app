"use client";

import { useAuth } from "./AuthProvider";
import { AuthScreen } from "./AuthScreen";
import { gateView } from "@/lib/authState";

/**
 * Session gate. Maps the auth status to one of three shells via the pure
 * `gateView` decision:
 *   - "checking" → neutral splash (no flash of login before /auth/me resolves)
 *   - "unauthed" → the login / 会員登録 screen
 *   - "authed"   → the app (chat-home + sub-pages), rendered as children
 *
 * The app content only MOUNTS when authed, so per-device localStorage data isn't
 * read until the user is in (Stage 2 will move that data behind the same gate).
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { state } = useAuth();
  const view = gateView(state.status);

  if (view === "splash") return <Splash />;
  if (view === "auth") return <AuthScreen />;
  return <>{children}</>;
}

function Splash() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 text-slate-400 dark:text-navy-400">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-accent dark:border-navy-700 dark:border-t-accent-light" />
      <span className="text-sm">読み込み中…</span>
    </div>
  );
}

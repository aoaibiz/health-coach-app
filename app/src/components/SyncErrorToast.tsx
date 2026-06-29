"use client";

import { useEffect, useState } from "react";
import { SYNC_ERROR_EVENT } from "@/lib/syncData";

/**
 * Small, transient notice shown when a server SAVE was REJECTED and could not
 * sync (e.g. the data exceeded the server's size cap → HTTP 400). The push layer
 * dispatches SYNC_ERROR_EVENT ONLY for NON-retryable failures — transient/offline
 * pushes retry silently — so this never nags on a flaky connection. The local
 * copy is always intact; this just tells the user a save didn't reach the server.
 *
 * Presentation only — it owns no app/sync logic, just listens for the event.
 * A11y: role="alert" + aria-live so screen readers announce it.
 */
export function SyncErrorToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const onSyncError = () => {
      setVisible(true);
      if (hideTimer) clearTimeout(hideTimer);
      // Auto-dismiss; a fresh failure re-arms the timer (no stacking of toasts).
      hideTimer = setTimeout(() => setVisible(false), 7000);
    };
    window.addEventListener(SYNC_ERROR_EVENT, onSyncError);
    return () => {
      window.removeEventListener(SYNC_ERROR_EVENT, onSyncError);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-x-0 bottom-24 z-50 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl bg-rose-600 px-4 py-3 text-sm font-medium text-white shadow-lg"
    >
      <span>同期できませんでした。データはこの端末に保存されています。</span>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="閉じる"
        className="-mr-1 shrink-0 rounded-md px-1.5 text-white/80 transition hover:bg-white/15 hover:text-white"
      >
        ✕
      </button>
    </div>
  );
}

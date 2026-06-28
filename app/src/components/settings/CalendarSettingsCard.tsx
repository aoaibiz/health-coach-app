"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  calendarStatus,
  calendarConnectUrl,
  calendarDisconnect,
  type CalendarStatus,
} from "@/lib/authApi";

/**
 * Googleカレンダー連携 settings card (Phase 1). Matches the profile page's
 * `surface` card aesthetic. The connection is a SEPARATE OAuth flow from login:
 * the user may connect a DIFFERENT Google account than the one they logged in
 * with (e.g. a work calendar) — so "連携する" is a full-page navigation to the
 * Worker's dedicated calendar-connect start endpoint (carrying the session
 * cookie), and the card shows which account is currently connected.
 *
 * States:
 *   loading        → reading status
 *   not configured → calendar feature unavailable (env not set) — short note
 *   not connected  → primary "Googleカレンダーと連携" button
 *   connected      → "連携中: <email>" + "連携を解除"
 * Plus a one-shot banner from the OAuth return (?calendar=connected|denied|error).
 */
export function CalendarSettingsCard() {
  const { state } = useAuth();
  const csrfToken = state.csrfToken;

  const [status, setStatus] = useState<CalendarStatus | null>(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await calendarStatus();
      setStatus(s);
    } catch {
      // Treat a status error as "unavailable" rather than blocking the page.
      setStatus({
        connected: false,
        scopeOk: false,
        configured: false,
        needsReconnect: false,
        reason: null,
        email: null,
      });
    }
  }, []);

  // Initial status + one-shot banner from the calendar-connect return.
  useEffect(() => {
    refresh();
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const marker = params.get("calendar");
    if (marker) {
      if (marker === "connected") setBanner("Googleカレンダーと連携しました。");
      else if (marker === "denied") setBanner("カレンダーの権限が許可されませんでした。もう一度お試しください。");
      else if (marker === "expired") setBanner("連携の有効期限が切れました。もう一度お試しください。");
      else if (marker === "unavailable") setBanner("カレンダー連携は現在利用できません。");
      else setBanner("カレンダー連携を完了できませんでした。もう一度お試しください。");
      // Clean the URL so a reload doesn't re-show the banner.
      params.delete("calendar");
      const q = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
    }
  }, [refresh]);

  function handleConnect() {
    // Full-page navigation (NOT a fetch): the SameSite=Lax session cookie rides
    // along, the user picks any Google account, and Google redirects back to
    // /profile?calendar=connected. Land back on this page.
    window.location.href = calendarConnectUrl("/profile");
  }

  async function handleDisconnect() {
    setBusy(true);
    setError(null);
    try {
      await calendarDisconnect(csrfToken);
      await refresh();
    } catch {
      setError("連携の解除に失敗しました。少し時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface space-y-4 p-5">
      <div>
        <h2 className="text-sm font-bold text-slate-700 dark:text-navy-100">Googleカレンダー連携</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-navy-300">
          連携すると、コーチに「今日の予定をカレンダーに入れて」と頼んだとき、食事・運動・タスクをあなたのGoogleカレンダーに登録できます。ログインとは別のGoogleアカウント（仕事用など）を選んで連携できます。
        </p>
      </div>

      {banner && (
        <p className="rounded-xl bg-accent/10 px-3 py-2.5 text-sm leading-relaxed text-accent dark:bg-accent-light/15 dark:text-accent-light">
          {banner}
        </p>
      )}

      {status === null && <p className="text-sm text-slate-400 dark:text-navy-400">読み込み中…</p>}

      {status && !status.configured && (
        <p className="text-sm leading-relaxed text-slate-500 dark:text-navy-300">
          カレンダー連携は現在利用できません。
        </p>
      )}

      {status && status.configured && !status.connected && (
        <div className="space-y-3">
          {status.needsReconnect && (
            <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm leading-relaxed text-amber-700 dark:bg-amber-400/10 dark:text-amber-200">
              カレンダー連携は残っていますが、予定登録に必要な権限か更新トークンが不足しています。もう一度連携してください。
            </p>
          )}
          <button
            type="button"
            onClick={handleConnect}
            className="btn-primary w-full py-3"
          >
            {status.needsReconnect ? "Googleカレンダーを再連携する" : "Googleカレンダーと連携する"}
          </button>
        </div>
      )}

      {status && status.configured && status.connected && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent dark:bg-accent-light/15 dark:text-accent-light">
              <span className="h-2 w-2 rounded-full bg-accent dark:bg-accent-light" />
              連携中
            </span>
            {status.email && (
              <span className="text-xs text-slate-500 dark:text-navy-300">{status.email}</span>
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={handleConnect}
              className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 transition active:scale-[0.98] hover:bg-slate-50 dark:border-navy-700 dark:text-navy-200 dark:hover:bg-navy-800"
            >
              別のアカウントに切り替え
            </button>
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
              className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 transition active:scale-[0.98] hover:bg-slate-50 disabled:opacity-60 dark:border-navy-700 dark:text-navy-200 dark:hover:bg-navy-800"
            >
              {busy ? "解除中…" : "連携を解除"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs leading-relaxed text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}

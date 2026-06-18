"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  disablePush,
  enablePush,
  getPushStatus,
  isPushSupported,
  sendTestPush,
  type PushStatus,
} from "@/lib/push";

/**
 * 通知 settings card (LINE-style push). Matches the profile page's `surface`
 * card aesthetic (white/navy theme, btn-primary). Reads the csrfToken from the
 * auth context — the same token used for logout — for the state-changing push
 * POSTs (subscribe/unsubscribe/test).
 *
 * Flow:
 *   default      → primary "通知をオンにする" (enablePush → permission prompt → sub)
 *   subscribed   → "オン" + "テスト通知を送る" + "通知をオフにする"
 *   denied       → explain it must be re-enabled in browser settings
 *   unsupported  → short note
 * Plus an always-visible iOS hint (Apple requires "ホーム画面に追加" first).
 */
export function PushSettingsCard() {
  const { state } = useAuth();
  const csrfToken = state.csrfToken;

  const [status, setStatus] = useState<PushStatus | null>(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Derive the initial status on mount (permission + existing subscription).
  useEffect(() => {
    let cancelled = false;
    if (!isPushSupported()) {
      setStatus("unsupported");
      return;
    }
    getPushStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus("unsubscribed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    setTestNote(null);
    try {
      const next = await enablePush(csrfToken);
      setStatus(next);
      if (next === "denied") {
        // Permission was blocked during the prompt — the denied note explains it.
      }
    } catch {
      setError("通知をオンにできませんでした。少し時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    setTestNote(null);
    try {
      const next = await disablePush(csrfToken);
      setStatus(next);
    } catch {
      setError("通知をオフにできませんでした。少し時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    setError(null);
    setTestNote(null);
    try {
      await sendTestPush(csrfToken);
      setTestNote("送信しました（届かない場合は通知の許可をご確認ください）");
    } catch {
      setError("テスト通知を送信できませんでした。少し時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface space-y-4 p-5">
      <div>
        <h2 className="text-sm font-bold text-slate-700 dark:text-navy-100">通知</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-navy-300">
          コーチからのリマインドやお知らせを、LINEのように受け取れます。
        </p>
      </div>

      {/* Loading the initial status */}
      {status === null && (
        <p className="text-sm text-slate-400 dark:text-navy-400">読み込み中…</p>
      )}

      {/* Unsupported browser */}
      {status === "unsupported" && (
        <p className="text-sm leading-relaxed text-slate-500 dark:text-navy-300">
          お使いのブラウザは通知に対応していません。最新のブラウザでお試しください。
        </p>
      )}

      {/* Permission previously blocked */}
      {status === "denied" && (
        <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          通知がブロックされています。ブラウザの設定からこのサイトの通知を「許可」に変更すると、もう一度オンにできます。
        </p>
      )}

      {/* Not asked yet / previously unsubscribed → primary enable button */}
      {(status === "default" || status === "unsubscribed") && (
        <button
          type="button"
          onClick={handleEnable}
          disabled={busy}
          className="btn-primary w-full py-3 disabled:opacity-60"
        >
          {busy ? "設定中…" : "通知をオンにする"}
        </button>
      )}

      {/* Subscribed → status badge + test + off */}
      {status === "subscribed" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent dark:bg-accent-light/15 dark:text-accent-light">
              <span className="h-2 w-2 rounded-full bg-accent dark:bg-accent-light" />
              オン
            </span>
            <span className="text-xs text-slate-400 dark:text-navy-400">
              この端末で通知を受け取れます
            </span>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={handleTest}
              disabled={busy}
              className="btn-primary flex-1 py-3 disabled:opacity-60"
            >
              {busy ? "送信中…" : "テスト通知を送る"}
            </button>
            <button
              type="button"
              onClick={handleDisable}
              disabled={busy}
              className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 transition active:scale-[0.98] hover:bg-slate-50 disabled:opacity-60 dark:border-navy-700 dark:text-navy-200 dark:hover:bg-navy-800"
            >
              通知をオフにする
            </button>
          </div>

          {testNote && (
            <p className="text-xs leading-relaxed text-slate-500 dark:text-navy-300">
              {testNote}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs leading-relaxed text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {/* iOS hint — always shown (Apple requires Add-to-Home-Screen for Web Push). */}
      <p className="text-xs leading-relaxed text-slate-400 dark:text-navy-400">
        iPhoneの場合は、Safariでこのアプリを「ホーム画面に追加」してから開くと通知を受け取れます（Appleの仕様）。
      </p>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";
import { AuthApiError, googleStartUrl } from "@/lib/authApi";
import { reduceRegistered, type AuthScreenMode } from "@/lib/authState";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  "google-cancelled": "Googleログインがキャンセルされました。もう一度お試しください。",
  "google-expired": "Googleログインの有効期限が切れました。もう一度お試しください。",
  "google-link-required":
    "このGoogleメールは既にパスワード登録済みです。メール/パスワードでログインしてください。",
  "google-failed": "Googleログインに失敗しました。もう一度お試しください。",
};

/**
 * The unauthenticated shell: login + 会員登録 screens (white/navy theme).
 *
 * Flow:
 *  - register → POST /auth/register → on 202 flip to login + show
 *    "登録しました。ログインしてください".
 *  - login → POST /auth/login → on 200 the AuthProvider enters the authed state
 *    and this screen unmounts (the gate swaps in the app / chat-home).
 *  - Googleでログイン → full-page nav to /auth/google/start. OAuth is deliberately
 *    a top-level navigation, not a probe fetch, so mobile Safari cannot lose the
 *    redirect/cookie flow.
 */
export function AuthScreen() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<AuthScreenMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [googleNote, setGoogleNote] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("authError");
    if (!authError) return;

    setError(OAUTH_ERROR_MESSAGES[authError] ?? OAUTH_ERROR_MESSAGES["google-failed"]);
    params.delete("authError");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
  }, []);

  function switchMode(next: AuthScreenMode) {
    setMode(next);
    setError(null);
    // Keep the post-register notice when we flip TO login; clear it otherwise.
    if (next === "register") setNotice(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const mail = email.trim();
    if (!mail || !password) {
      setError("メールアドレスとパスワードを入力してください");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "register") {
        await register(mail, password);
        // 202: no auto-login → flip to the login screen with a heads-up.
        setMode(reduceRegistered());
        setNotice("登録を受け付けました。既に登録済みの場合、パスワードは変更されません。ログインしてください。");
        setPassword("");
      } else {
        await login(mail, password);
        // On success the provider enters "authed" and this component unmounts.
      }
    } catch (err) {
      if (err instanceof AuthApiError && err.status === 401) {
        setError("メールアドレスかパスワードが違います。Googleで登録した方は「Googleでログイン」を使ってください。");
        return;
      }
      setError(
        err instanceof AuthApiError
          ? err.message
          : "通信に失敗しました。時間をおいて再度お試しください",
      );
    } finally {
      setBusy(false);
    }
  }

  function handleGoogle() {
    setGoogleNote(null);
    setError(null);
    setGoogleNote("Googleログインへ移動します…");
    // OAuth must be a plain top-level navigation. A probe fetch is brittle on
    // mobile Safari and consumes an OAuth state before the real navigation.
    window.location.assign(googleStartUrl());
  }

  const isRegister = mode === "register";

  return (
    <div className="relative flex h-[100dvh] flex-col justify-center overflow-hidden px-6 py-10">
      {/* full-bleed background photo */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/login-bg.jpg" alt="" aria-hidden className="absolute inset-0 -z-20 h-full w-full scale-105 object-cover" />
      {/* scrim for legibility (darkens the photo so the glass card pops) +
          a faint accent glow from the top so the brand colour bleeds in. */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-black/45 via-black/30 to-black/65" />
      <div aria-hidden className="absolute -top-32 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full bg-accent/30 blur-[100px]" />
      {/* centered card */}
      <div className="mx-auto w-full max-w-md animate-fade-in-up">
        <div className="rounded-[1.75rem] border border-white/40 bg-white/90 p-7 shadow-2xl ring-1 ring-black/5 backdrop-blur-2xl dark:border-white/10 dark:bg-navy-900/85">
          <header className="mb-6 text-center">
          <span className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-[1.1rem] bg-gradient-to-br from-accent-light to-accent-dark text-white shadow-glow-accent" aria-hidden>
            <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.5 6.5c-1.8 6.5-6 9.5-9.5 11C8 18 5 17 4 13.5 7 14 9 12.5 9.5 10c.4-2 .2-3.8 1.5-5.5C13 7 16.5 6 20.5 6.5z" />
            </svg>
          </span>
          <h1 className="text-[1.7rem] font-bold tracking-tight text-slate-900 dark:text-navy-50">
            Health
          </h1>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-navy-300">
            {isRegister ? "会員登録して始めましょう" : "ログインして続ける"}
          </p>
        </header>

        {notice && (
          <p className="mb-4 rounded-xl bg-emerald-50 px-3.5 py-2.5 text-sm font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">
            {notice}
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="auth-email" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-navy-200">
              メールアドレス
            </label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="field"
              required
            />
          </div>
          <div>
            <label htmlFor="auth-password" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-navy-200">
              パスワード
            </label>
            <input
              id="auth-password"
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="field"
              required
            />
          </div>

          {error && (
            <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full py-3">
            {busy ? "処理中…" : isRegister ? "会員登録する" : "ログイン"}
          </button>
        </form>

        {/* Divider */}
        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-slate-200 dark:bg-navy-700" />
          <span className="text-xs text-slate-400 dark:text-navy-400">または</span>
          <span className="h-px flex-1 bg-slate-200 dark:bg-navy-700" />
        </div>

        <button
          type="button"
          onClick={handleGoogle}
          className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition active:scale-[0.98] hover:bg-slate-50 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-50 dark:hover:bg-navy-700"
        >
          <GoogleMark />
          Googleでログイン
        </button>
        {googleNote && (
          <p className="mt-2 text-center text-xs text-slate-500 dark:text-navy-300">
            {googleNote}
          </p>
        )}

        <p className="mt-6 text-center text-sm text-slate-500 dark:text-navy-300">
          {isRegister ? "すでにアカウントをお持ちですか？" : "アカウントが未登録の方は"}{" "}
          <button
            type="button"
            onClick={() => switchMode(isRegister ? "login" : "register")}
            className="font-semibold text-accent transition hover:underline dark:text-accent-light"
          >
            {isRegister ? "ログイン" : "会員登録"}
          </button>
        </p>
        </div>
      </div>
    </div>
  );
}

/** Inline Google "G" mark (no external asset / dep). */
function GoogleMark() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

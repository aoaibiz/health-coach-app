"use client";

import { useState } from "react";
import { useAuth } from "./AuthProvider";
import { AuthApiError, googleStartUrl } from "@/lib/authApi";
import { reduceRegistered, type AuthScreenMode } from "@/lib/authState";

/**
 * The unauthenticated shell: login + 会員登録 screens (white/navy theme).
 *
 * Flow:
 *  - register → POST /auth/register → on 202 flip to login + show
 *    "登録しました。ログインしてください".
 *  - login → POST /auth/login → on 200 the AuthProvider enters the authed state
 *    and this screen unmounts (the gate swaps in the app / chat-home).
 *  - Googleでログイン → full-page nav to /auth/google/start. While the OAuth
 *    client secret isn't set the endpoint 503s, so we probe it first and show
 *    "現在準備中" instead of bouncing the user to an error page.
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
        setNotice("登録しました。ログインしてください");
        setPassword("");
      } else {
        await login(mail, password);
        // On success the provider enters "authed" and this component unmounts.
      }
    } catch (err) {
      setError(
        err instanceof AuthApiError
          ? err.message
          : "通信に失敗しました。時間をおいて再度お試しください",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setGoogleNote(null);
    setError(null);
    try {
      // Probe first: the endpoint redirects (or 503s until the secret is set).
      // `redirect: "manual"` keeps us on this page so we can read the status.
      const res = await fetch(googleStartUrl(), {
        method: "GET",
        credentials: "include",
        redirect: "manual",
      });
      // opaqueredirect (status 0 / type "opaqueredirect") = the real redirect to
      // Google happened → follow it. A 503 = not configured yet.
      if (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400)) {
        window.location.href = googleStartUrl();
        return;
      }
      if (res.status === 503) {
        setGoogleNote("Googleログインは現在準備中です");
        return;
      }
      // Any other 2xx/4xx: just navigate and let the backend decide.
      window.location.href = googleStartUrl();
    } catch {
      // Network hiccup → let a plain navigation try (also covers strict CORS on
      // the probe). If it 503s the destination shows準備中 server-side too.
      window.location.href = googleStartUrl();
    }
  }

  const isRegister = mode === "register";

  return (
    <div className="relative flex h-[100dvh] flex-col justify-center overflow-hidden px-6 py-10">
      {/* full-bleed background photo */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/login-bg.jpg" alt="" aria-hidden className="absolute inset-0 -z-20 h-full w-full object-cover" />
      {/* scrim for legibility (darkens the photo so the glass card pops) */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-black/40 via-black/25 to-black/60" />
      {/* centered card */}
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-3xl border border-white/40 bg-white/90 p-6 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-navy-900/85">
          <header className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-navy-50">
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

          <button type="submit" disabled={busy} className="btn-primary w-full py-2.5">
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
          className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition active:scale-[0.98] hover:bg-slate-50 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-50 dark:hover:bg-navy-700"
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

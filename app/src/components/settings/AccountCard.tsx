"use client";

import { useAuth } from "@/components/auth/AuthProvider";
import { UserIcon } from "@/components/icons";

/**
 * ログイン中のアカウント（メールアドレス）を明示するカード。Ao 2026-06-24: 複数
 * アカウントの取り違え（hiro38384 と hiro383845 を間違えた）の恒久対策として、
 * 「今どのアカウントで使っているか」をいつでも確認できるようにする。
 *
 * 表示するのは認証コンテキストの user.email のみ（端末ローカルの認証状態が真実）。
 * email が無い／未ログインのときは何も描画しない（捏造しない）。
 */
export function AccountCard() {
  const { state } = useAuth();
  const email =
    state.status === "authed" && typeof state.user?.email === "string"
      ? state.user.email.trim()
      : "";
  if (!email) return null;

  return (
    <section className="surface flex items-center gap-3 p-4" aria-label="ログイン中のアカウント">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent dark:bg-accent-light/15 dark:text-accent-light">
        <UserIcon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-navy-400">
          ログイン中のアカウント
        </p>
        <p className="mt-0.5 truncate text-sm font-semibold text-slate-800 dark:text-navy-50" title={email}>
          {email}
        </p>
      </div>
    </section>
  );
}

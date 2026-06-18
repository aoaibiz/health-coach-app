"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "./ThemeProvider";
import { useAuth } from "./auth/AuthProvider";
import {
  CalendarIcon,
  ChartIcon,
  ChatIcon,
  CloseIcon,
  DumbbellIcon,
  MealIcon,
  MoonIcon,
  SunIcon,
  UserIcon,
} from "./icons";

// CHAT is the home/landing (path "/" and "/chat" both render the chat). The
// other features are SUB — reachable from the menu drawer below, not co-equal
// primary tabs.
const SUB_PAGES = [
  {
    href: "/dashboard",
    label: "成果",
    Icon: ChartIcon,
    match: (p: string) => p.startsWith("/dashboard"),
  },
  {
    href: "/meal",
    label: "食事",
    Icon: MealIcon,
    match: (p: string) => p.startsWith("/meal"),
  },
  {
    href: "/workout",
    label: "筋トレ",
    Icon: DumbbellIcon,
    match: (p: string) => p.startsWith("/workout"),
  },
  {
    href: "/calendar",
    label: "カレンダー",
    Icon: CalendarIcon,
    match: (p: string) => p.startsWith("/calendar"),
  },
];

/** Chat is "home": active on both "/" and "/chat". */
function isChatHome(p: string): boolean {
  return p === "/" || p.startsWith("/chat");
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "ライトモードへ" : "ダークモードへ"}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 transition active:scale-95 hover:bg-slate-50 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-100 dark:hover:bg-navy-700"
    >
      {isDark ? <MoonIcon className="h-5 w-5" /> : <SunIcon className="h-5 w-5" />}
    </button>
  );
}

/** Hamburger / grid icon for the sub-pages menu (kept inline to avoid touching
 *  the shared icon set). */
function MenuIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const chatHome = isChatHome(pathname);
  const { logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="mx-auto flex h-[100dvh] max-w-md flex-col overflow-hidden">
      {/* Header — in-flow row above the scroll region; stays visible as a sibling. */}
      <header className="shrink-0 border-b border-slate-200/70 bg-slate-50/80 backdrop-blur-md dark:border-navy-800 dark:bg-navy-950/80">
        <div className="flex h-14 items-center justify-between px-5">
          <span className="text-lg font-bold tracking-tight">Health</span>
          <div className="flex items-center gap-2">
            <Link
              href="/profile"
              aria-label="プロフィール"
              className={`flex h-9 w-9 items-center justify-center rounded-full border transition active:scale-95 ${
                pathname.startsWith("/profile")
                  ? "border-accent bg-accent/10 text-accent dark:border-accent-light dark:bg-accent-light/15 dark:text-accent-light"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-100 dark:hover:bg-navy-700"
              }`}
            >
              <UserIcon className="h-5 w-5" />
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Content — scrolls inside the locked viewport; min-h-0 lets the flex child
          shrink below content size so the inner area (not the page) scrolls. */}
      <main className={`flex-1 min-h-0 px-4 pt-4 ${chatHome ? "overflow-hidden" : "overflow-y-auto"}`}>{children}</main>

      {/* Bottom nav: CHAT is home (primary). The other pages live behind メニュー.
          In-flow row at the bottom of the flex column. */}
      <nav className="shrink-0 border-t border-slate-200/70 bg-white/90 backdrop-blur-md dark:border-navy-800 dark:bg-navy-900/90">
        <div className="grid grid-cols-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
          <Link
            href="/"
            className={`flex flex-col items-center gap-1 rounded-xl py-1.5 text-xs font-semibold transition active:scale-95 ${
              isChatHome(pathname)
                ? "text-accent dark:text-accent-light"
                : "text-slate-400 dark:text-navy-300"
            }`}
          >
            <ChatIcon className="h-6 w-6" />
            <span>ホーム（チャット）</span>
          </Link>
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="メニューを開く"
            className={`flex flex-col items-center gap-1 rounded-xl py-1.5 text-xs font-medium transition active:scale-95 ${
              SUB_PAGES.some((t) => t.match(pathname))
                ? "text-accent dark:text-accent-light"
                : "text-slate-400 dark:text-navy-300"
            }`}
          >
            <MenuIcon className="h-6 w-6" />
            <span>メニュー</span>
          </button>
        </div>
      </nav>

      {/* Menu drawer — the demoted-but-reachable sub-pages + logout. */}
      {menuOpen && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end">
          {/* Backdrop */}
          <button
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          />
          {/* Sheet */}
          <div className="relative mx-auto w-full max-w-md rounded-t-3xl border-t border-slate-200/70 bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl dark:border-navy-800 dark:bg-navy-900">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-bold tracking-tight text-slate-700 dark:text-navy-100">
                メニュー
              </span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="閉じる"
                className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition active:scale-95 hover:bg-slate-100 dark:text-navy-300 dark:hover:bg-navy-800"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              {SUB_PAGES.map(({ href, label, Icon, match }) => {
                const active = match(pathname);
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setMenuOpen(false)}
                    className={`flex flex-col items-center gap-2 rounded-2xl border px-3 py-4 text-sm font-semibold transition active:scale-[0.98] ${
                      active
                        ? "border-accent bg-accent/10 text-accent dark:border-accent-light dark:bg-accent-light/15 dark:text-accent-light"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-navy-700 dark:bg-navy-800 dark:text-navy-100 dark:hover:bg-navy-700"
                    }`}
                  >
                    <Icon className="h-7 w-7" />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                void logout();
              }}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 py-3 text-sm font-semibold text-slate-600 transition active:scale-[0.98] hover:bg-slate-50 dark:border-navy-700 dark:text-navy-200 dark:hover:bg-navy-800"
            >
              ログアウト
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

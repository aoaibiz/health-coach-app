"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "./ThemeProvider";
import { useSelectedDate } from "./SelectedDateProvider";
import { useAuth } from "./auth/AuthProvider";
import { toDateKey } from "@/lib/date";
import {
  CalendarIcon,
  ChartIcon,
  ChatIcon,
  CloseIcon,
  DumbbellIcon,
  FlameIcon,
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
    label: "運動",
    Icon: DumbbellIcon,
    match: (p: string) => p.startsWith("/workout"),
  },
  {
    href: "/cardio",
    label: "有酸素",
    Icon: FlameIcon,
    match: (p: string) => p.startsWith("/cardio"),
  },
  {
    href: "/sleep",
    label: "睡眠",
    Icon: MoonIcon,
    match: (p: string) => p.startsWith("/sleep"),
  },
  {
    href: "/calendar",
    label: "カレンダー",
    Icon: CalendarIcon,
    match: (p: string) => p.startsWith("/calendar"),
  },
  {
    href: "/history",
    label: "履歴・傾向",
    Icon: ChartIcon,
    match: (p: string) => p.startsWith("/history"),
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

/** The app's brand mark — a small rounded-square "leaf/spark" badge in the
 *  accent gradient. Pure presentation; gives the wordmark an iconic anchor
 *  (the kind of mark an App Store listing needs). */
function BrandMark() {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 items-center justify-center rounded-[0.7rem] bg-gradient-to-br from-accent-light to-accent-dark text-white shadow-glow-accent"
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.5 6.5c-1.8 6.5-6 9.5-9.5 11C8 18 5 17 4 13.5 7 14 9 12.5 9.5 10c.4-2 .2-3.8 1.5-5.5C13 7 16.5 6 20.5 6.5z" />
      </svg>
    </span>
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

/** All primary destinations (chat-home + the sub-pages) as ONE list, used by the
 *  desktop sidebar so every feature is a visible, co-equal nav item on a wide
 *  screen (no hidden メニュー drawer). Mobile keeps the compact home/メニュー nav. */
const DESKTOP_NAV = [
  {
    href: "/",
    label: "ホーム（チャット）",
    Icon: ChatIcon,
    match: isChatHome,
  },
  ...SUB_PAGES,
];

/** Shared active/inactive styling for a desktop sidebar nav item. The active
 *  item gets a soft gradient pill + accent glow; inactive items slide a hair to
 *  the right on hover — the small motion cue that reads as "polished". */
function sidebarItemClass(active: boolean): string {
  return `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 ease-spring active:scale-[0.98] ${
    active
      ? "bg-gradient-to-r from-accent/15 to-accent/5 text-accent shadow-sm ring-1 ring-accent/15 dark:from-accent-light/20 dark:to-accent-light/5 dark:text-accent-light dark:ring-accent-light/15"
      : "text-slate-600 hover:translate-x-0.5 hover:bg-slate-100/80 dark:text-navy-200 dark:hover:bg-navy-800/80"
  }`;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const chatHome = isChatHome(pathname);
  const { logout, state } = useAuth();
  const { setDate } = useSelectedDate();
  const [menuOpen, setMenuOpen] = useState(false);
  const resetDateToToday = () => setDate(toDateKey());
  // ログイン中のメールアドレス（あれば）— どのアカウントか常に分かるよう nav に表示。
  const email =
    state.status === "authed" && typeof state.user?.email === "string"
      ? state.user.email.trim()
      : "";

  return (
    // Responsive shell: on mobile a single centered column (max-w-md, unchanged);
    // on desktop (lg+) a left sidebar + a wide content column so the app reads as
    // a real desktop app instead of a stretched phone layout.
    <div className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden lg:max-w-6xl lg:flex-row">
      {/* Desktop sidebar — hidden on mobile (lg:flex). Holds the brand, the full
          nav, and account actions, so the wide screen has its own chrome. */}
      <aside className="hidden shrink-0 flex-col border-r border-slate-200/60 bg-white/50 backdrop-blur-xl lg:flex lg:w-64 xl:w-72 dark:border-navy-800/70 dark:bg-navy-950/40">
        <div className="flex h-16 items-center gap-2.5 px-6">
          <BrandMark />
          <span className="text-xl font-bold tracking-tight">Health</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {DESKTOP_NAV.map(({ href, label, Icon, match }) => {
            const active = match(pathname);
            return (
              <Link
                key={href}
                href={href}
                onClick={href === "/" ? undefined : resetDateToToday}
                className={sidebarItemClass(active)}
              >
                <Icon className="h-5 w-5 shrink-0 transition-transform duration-200 ease-spring group-hover:scale-110" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="space-y-1 border-t border-slate-200/70 px-3 py-3 dark:border-navy-800">
          {email && (
            <div className="px-3 pb-1.5" title={email}>
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-navy-500">
                ログイン中
              </p>
              <p className="truncate text-xs font-semibold text-slate-600 dark:text-navy-200">
                {email}
              </p>
            </div>
          )}
          <Link
            href="/profile"
            className={sidebarItemClass(pathname.startsWith("/profile"))}
          >
            <UserIcon className="h-5 w-5 shrink-0" />
            <span>プロフィール</span>
          </Link>
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-slate-400 dark:text-navy-400">
              テーマ
            </span>
            <ThemeToggle />
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-600 transition active:scale-[0.98] hover:bg-slate-100 dark:text-navy-200 dark:hover:bg-navy-800"
          >
            ログアウト
          </button>
        </div>
      </aside>

      {/* Main column (header + content + mobile nav). min-w-0 lets it shrink/grow
          correctly beside the sidebar; flex-col keeps the locked-viewport layout. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header — in-flow row above the scroll region; stays visible as a sibling.
          Hidden on desktop where the sidebar carries the brand + actions. */}
      <header className="shrink-0 border-b border-slate-200/60 bg-white/70 backdrop-blur-xl lg:hidden dark:border-navy-800/70 dark:bg-navy-950/70">
        <div className="flex h-14 items-center justify-between px-5">
          <span className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <BrandMark />
            Health
          </span>
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
          shrink below content size so the inner area (not the page) scrolls. On
          desktop the readable content is centered + wider (not edge-to-edge) so a
          1440px screen doesn't stretch cards across the full width. */}
      <main className={`flex-1 min-h-0 px-4 pt-4 lg:px-8 lg:pt-8 ${chatHome ? "overflow-hidden" : "overflow-y-auto"}`}>
        <div className="mx-auto h-full w-full lg:max-w-3xl xl:max-w-4xl">{children}</div>
      </main>

      {/* Bottom nav: CHAT is home (primary). The other pages live behind メニュー.
          In-flow row at the bottom of the flex column. Hidden on desktop (the
          sidebar replaces it). */}
      <nav className="shrink-0 border-t border-slate-200/60 bg-white/80 backdrop-blur-xl lg:hidden dark:border-navy-800/70 dark:bg-navy-900/80">
        <div className="grid grid-cols-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
          {(() => {
            const homeActive = isChatHome(pathname);
            const menuActive = SUB_PAGES.some((t) => t.match(pathname));
            return (
              <>
                <Link
                  href="/"
                  className={`relative flex flex-col items-center gap-1 rounded-xl py-1.5 text-xs font-semibold transition duration-200 ease-spring active:scale-95 ${
                    homeActive
                      ? "text-accent dark:text-accent-light"
                      : "text-slate-400 hover:text-slate-600 dark:text-navy-300 dark:hover:text-navy-100"
                  }`}
                >
                  {homeActive && (
                    <span aria-hidden className="absolute -top-2 h-1 w-8 rounded-full bg-accent dark:bg-accent-light" />
                  )}
                  <ChatIcon className={`h-6 w-6 transition-transform duration-200 ease-spring ${homeActive ? "scale-110" : ""}`} />
                  <span>ホーム（チャット）</span>
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    resetDateToToday();
                    setMenuOpen(true);
                  }}
                  aria-label="メニューを開く"
                  className={`relative flex flex-col items-center gap-1 rounded-xl py-1.5 text-xs font-medium transition duration-200 ease-spring active:scale-95 ${
                    menuActive
                      ? "text-accent dark:text-accent-light"
                      : "text-slate-400 hover:text-slate-600 dark:text-navy-300 dark:hover:text-navy-100"
                  }`}
                >
                  {menuActive && (
                    <span aria-hidden className="absolute -top-2 h-1 w-8 rounded-full bg-accent dark:bg-accent-light" />
                  )}
                  <MenuIcon className={`h-6 w-6 transition-transform duration-200 ease-spring ${menuActive ? "scale-110" : ""}`} />
                  <span>メニュー</span>
                </button>
              </>
            );
          })()}
        </div>
      </nav>
      </div>

      {/* Menu drawer — the demoted-but-reachable sub-pages + logout. Mobile-only
          (the desktop sidebar shows every page directly). */}
      {menuOpen && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end lg:hidden">
          {/* Backdrop */}
          <button
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 animate-fade-in bg-slate-900/40 backdrop-blur-sm"
          />
          {/* Sheet */}
          <div className="relative mx-auto w-full max-w-md animate-fade-in-up rounded-t-3xl border-t border-slate-200/70 bg-white/95 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-xl dark:border-navy-800 dark:bg-navy-900/95">
            {/* grab handle */}
            <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-slate-300 dark:bg-navy-700" />
            <div className="mb-4 flex items-center justify-between">
              <div className="min-w-0">
                <span className="text-sm font-bold tracking-tight text-slate-700 dark:text-navy-100">
                  メニュー
                </span>
                {email && (
                  <span
                    className="block max-w-[220px] truncate text-[11px] font-medium text-slate-400 dark:text-navy-400"
                    title={email}
                  >
                    {email}
                  </span>
                )}
              </div>
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
                    onClick={() => {
                      resetDateToToday();
                      setMenuOpen(false);
                    }}
                    className={`group flex flex-col items-center gap-2 rounded-2xl border px-3 py-4 text-sm font-semibold transition duration-200 ease-spring hover:-translate-y-0.5 active:scale-[0.97] ${
                      active
                        ? "border-accent/40 bg-gradient-to-b from-accent/15 to-accent/5 text-accent shadow-glow-accent dark:border-accent-light/40 dark:from-accent-light/20 dark:to-accent-light/5 dark:text-accent-light"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:shadow-card dark:border-navy-700 dark:bg-navy-800 dark:text-navy-100 dark:hover:bg-navy-700"
                    }`}
                  >
                    <Icon className="h-7 w-7 transition-transform duration-200 ease-spring group-hover:scale-110" />
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

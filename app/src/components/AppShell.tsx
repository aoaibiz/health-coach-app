"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "./ThemeProvider";
import { useSelectedDate } from "./SelectedDateProvider";
import { useAuth } from "./auth/AuthProvider";
import { toDateKey } from "@/lib/date";
import {
  ChartIcon,
  ChatIcon,
  DumbbellIcon,
  FlameIcon,
  HomeIcon,
  MealIcon,
  MoonIcon,
  SunIcon,
  UserIcon,
} from "./icons";

/*
 * ── Information architecture (2026-07 re-imagining) ─────────────────────────
 * 5 always-visible primary destinations (one tap to everything, no drawer):
 *   ホーム(/)   — 今日: today-at-a-glance hero, quick-log, streak, weight, sleep
 *   食事(/meal) — meal log (photo/text → AI解析), the most frequent action
 *   コーチ(/chat) — 健康マン AI coach (raised centre button)
 *   運動(/workout) — strength log + GPS有酸素 launcher (/cardio keeps its screen)
 *   データ(/data) — trends(履歴・傾向) + カレンダー merged into one hub
 * プロフィール stays in the header (mobile) / sidebar footer (desktop).
 * /dashboard renders the home; /history & /calendar render the data hub —
 * every old URL keeps working.
 */
interface NavItem {
  href: string;
  label: string;
  Icon: (p: React.SVGProps<SVGSVGElement>) => JSX.Element;
  /** Active-state matcher for THIS tab (desktop sidebar; narrow). */
  match: (p: string) => boolean;
  /** Mobile matcher — folds satellite pages (有酸素→運動, 睡眠→ホーム) into the
   *  nearest tab so the bar always shows where you are. */
  broad: (p: string) => boolean;
  /** The raised centre button (コーチ). */
  center?: boolean;
}

const PRIMARY_NAV: NavItem[] = [
  {
    href: "/",
    label: "ホーム",
    Icon: HomeIcon,
    match: (p) => p === "/" || p.startsWith("/dashboard"),
    broad: (p) => p === "/" || p.startsWith("/dashboard") || p.startsWith("/sleep"),
  },
  {
    href: "/meal",
    label: "食事",
    Icon: MealIcon,
    match: (p) => p.startsWith("/meal"),
    broad: (p) => p.startsWith("/meal"),
  },
  {
    href: "/chat",
    label: "コーチ",
    Icon: ChatIcon,
    match: (p) => p.startsWith("/chat"),
    broad: (p) => p.startsWith("/chat"),
    center: true,
  },
  {
    href: "/workout",
    label: "運動",
    Icon: DumbbellIcon,
    match: (p) => p.startsWith("/workout"),
    broad: (p) => p.startsWith("/workout") || p.startsWith("/cardio"),
  },
  {
    href: "/data",
    label: "データ",
    Icon: ChartIcon,
    match: (p) =>
      p.startsWith("/data") || p.startsWith("/history") || p.startsWith("/calendar"),
    broad: (p) =>
      p.startsWith("/data") || p.startsWith("/history") || p.startsWith("/calendar"),
  },
];

/** Desktop-only satellite links (their own rows so a wide screen reaches them
 *  directly; on mobile they're one tap inside ホーム / 運動). */
const SATELLITE_NAV = [
  {
    href: "/cardio",
    label: "有酸素（GPS計測）",
    Icon: FlameIcon,
    match: (p: string) => p.startsWith("/cardio"),
  },
  {
    href: "/sleep",
    label: "睡眠",
    Icon: MoonIcon,
    match: (p: string) => p.startsWith("/sleep"),
  },
];

/** The chat screen locks its own scroll (message list scrolls, page doesn't). */
function isChatPage(p: string): boolean {
  return p.startsWith("/chat");
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
 *  accent gradient. Pure presentation; gives the wordmark an iconic anchor. */
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

/** Shared active/inactive styling for a desktop sidebar nav item. */
function sidebarItemClass(active: boolean): string {
  return `group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition duration-200 ease-spring active:scale-[0.98] ${
    active
      ? "bg-gradient-to-r from-accent/15 to-accent/5 text-accent shadow-sm ring-1 ring-accent/15 dark:from-accent-light/20 dark:to-accent-light/5 dark:text-accent-light dark:ring-accent-light/15"
      : "text-slate-600 hover:translate-x-0.5 hover:bg-slate-100/80 dark:text-navy-200 dark:hover:bg-navy-800/80"
  }`;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const chat = isChatPage(pathname);
  const { logout, state } = useAuth();
  const { setDate } = useSelectedDate();
  const resetDateToToday = () => setDate(toDateKey());
  // ログイン中のメールアドレス（あれば）— どのアカウントか常に分かるよう nav に表示。
  const email =
    state.status === "authed" && typeof state.user?.email === "string"
      ? state.user.email.trim()
      : "";

  return (
    // Responsive shell: on mobile a single centered column (max-w-md);
    // on desktop (lg+) a left sidebar + a wide content column.
    <div className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden lg:max-w-6xl lg:flex-row">
      {/* Desktop sidebar — hidden on mobile (lg:flex). */}
      <aside className="hidden shrink-0 flex-col border-r border-slate-200/60 bg-white/50 backdrop-blur-xl lg:flex lg:w-64 xl:w-72 dark:border-navy-800/70 dark:bg-navy-950/40">
        <div className="flex h-16 items-center gap-2.5 px-6">
          <BrandMark />
          <span className="text-xl font-bold tracking-tight">Health</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {PRIMARY_NAV.map(({ href, label, Icon, match }) => {
            const active = match(pathname);
            return (
              <Link
                key={href}
                href={href}
                onClick={href === "/chat" ? undefined : resetDateToToday}
                aria-current={active ? "page" : undefined}
                className={sidebarItemClass(active)}
              >
                <Icon className="h-5 w-5 shrink-0 transition-transform duration-200 ease-spring group-hover:scale-110" />
                <span>{label}</span>
              </Link>
            );
          })}
          <p className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-navy-500">
            記録ツール
          </p>
          {SATELLITE_NAV.map(({ href, label, Icon, match }) => {
            const active = match(pathname);
            return (
              <Link
                key={href}
                href={href}
                onClick={resetDateToToday}
                aria-current={active ? "page" : undefined}
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
            aria-current={pathname.startsWith("/profile") ? "page" : undefined}
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

      {/* Main column (header + content + mobile nav). */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile header — brand + account + theme. Hidden on desktop. */}
        <header className="shrink-0 lg:hidden">
          <div className="flex h-14 items-center justify-between gap-2 px-5">
            <span className="flex shrink-0 items-center gap-2 text-lg font-bold tracking-tight">
              <BrandMark />
              Health
            </span>
            <div className="flex min-w-0 items-center gap-2">
              {/* ログイン中のアカウント（メール）を常に表示 — 取り違え防止。タップで
                  プロフィールへ。email が無い／未ログインのときはアイコンのみ。 */}
              <Link
                href="/profile"
                aria-label={email ? `プロフィール（ログイン中: ${email}）` : "プロフィール"}
                title={email || undefined}
                className={`flex min-w-0 items-center gap-1.5 rounded-full border backdrop-blur-md transition active:scale-95 ${
                  email ? "max-w-[9.5rem] px-2.5 py-1.5" : "h-9 w-9 justify-center"
                } ${
                  pathname.startsWith("/profile")
                    ? "border-accent bg-accent/10 text-accent dark:border-accent-light dark:bg-accent-light/15 dark:text-accent-light"
                    : "border-slate-200 bg-white/80 text-slate-700 hover:bg-slate-50 dark:border-navy-700 dark:bg-navy-800/80 dark:text-navy-100 dark:hover:bg-navy-700"
                }`}
              >
                <UserIcon className="h-5 w-5 shrink-0" />
                {email && <span className="truncate text-xs font-semibold">{email}</span>}
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </header>

        {/* Content — scrolls inside the locked viewport (except chat, which owns
            its scroll). Centered + width-capped on desktop. */}
        <main className={`flex-1 min-h-0 px-4 pt-2 lg:px-8 lg:pt-8 ${chat ? "overflow-hidden pb-2" : "overflow-y-auto"}`}>
          <div className="mx-auto h-full w-full lg:max-w-3xl xl:max-w-4xl">{children}</div>
        </main>

        {/* Mobile bottom nav — a floating 5-tab bar: every primary destination is
            ONE tap (no menu drawer). コーチ is the raised centre button. */}
        <nav className="shrink-0 px-3 pb-[max(0.6rem,env(safe-area-inset-bottom))] pt-1.5 lg:hidden">
          <div className="mx-auto grid max-w-md grid-cols-5 items-end rounded-[1.4rem] border border-slate-200/70 bg-white/90 px-1 pb-1.5 pt-1.5 shadow-card backdrop-blur-xl dark:border-navy-800/80 dark:bg-navy-900/90 dark:shadow-card-dark">
            {PRIMARY_NAV.map(({ href, label, Icon, broad, center }) => {
              const active = broad(pathname);
              if (center) {
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-label={label}
                    aria-current={active ? "page" : undefined}
                    className="group relative flex flex-col items-center gap-0.5"
                  >
                    <span
                      className={`-mt-6 flex h-[3.4rem] w-[3.4rem] items-center justify-center rounded-full border-4 border-white bg-gradient-to-br from-accent-light to-accent-dark text-white shadow-glow-accent transition duration-200 ease-spring group-active:scale-90 dark:border-navy-900 ${
                        active ? "scale-105" : ""
                      }`}
                    >
                      <Icon className="h-6 w-6" />
                    </span>
                    <span
                      className={`pb-0.5 text-[10px] font-semibold ${
                        active
                          ? "text-accent dark:text-accent-light"
                          : "text-slate-400 dark:text-navy-300"
                      }`}
                    >
                      {label}
                    </span>
                  </Link>
                );
              }
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={resetDateToToday}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 rounded-2xl text-[10px] font-semibold transition duration-200 ease-spring active:scale-90 ${
                    active
                      ? "text-accent dark:text-accent-light"
                      : "text-slate-400 hover:text-slate-600 dark:text-navy-300 dark:hover:text-navy-100"
                  }`}
                >
                  {active && (
                    <span
                      aria-hidden
                      className="absolute inset-x-1.5 inset-y-0.5 -z-10 animate-pop-in rounded-2xl bg-accent/10 dark:bg-accent-light/10"
                    />
                  )}
                  <Icon
                    className={`h-6 w-6 transition-transform duration-200 ease-spring ${
                      active ? "scale-110" : ""
                    }`}
                  />
                  <span>{label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}

// Thin client for the live auth backend (Stage 1).
//
// The app is served from https://health.mogubusi.trade and the API lives on the
// sibling subdomain https://health-api.mogubusi.trade. Because it is a DIFFERENT
// origin, EVERY auth request must use `credentials: "include"` so the HttpOnly
// session cookie is sent/received. The browser attaches the Origin header
// automatically; the API CORS-allows our origin with credentials.
//
// State-changing requests (logout — and later the data PUT in Stage 2) also send
// `X-CSRF-Token: <csrfToken from login>`.
//
// Static-export-safe: this module has NO top-level window/localStorage access.

import type { AuthUser } from "./authState";

/**
 * Single source of truth for the API base URL. Overridable at build time via
 * NEXT_PUBLIC_HEALTH_API (so Stage 2 + non-prod envs are a one-line change),
 * defaulting to the live production API.
 */
export const HEALTH_API_BASE = (
  process.env.NEXT_PUBLIC_HEALTH_API ?? "https://health-api.mogubusi.trade"
).replace(/\/$/, "");

function apiUrl(path: string): string {
  return `${HEALTH_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The login response = user fields + a csrfToken. */
export interface LoginResult {
  user: AuthUser;
  csrfToken: string;
}

/**
 * The /auth/me result = the user plus the session's csrfToken (re-surfaced so a
 * reloaded SPA can sync the token and still authorize logout). null when 401.
 */
export interface MeResult {
  user: AuthUser;
  csrfToken: string;
}

export interface RegisterResult {
  ok: boolean;
  message?: string;
}

/** A typed error so the UI can branch on the HTTP status (401, 503, …). */
export class AuthApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

// Test seam: callers (and tests) can inject a fetch implementation.
export interface FetchOption {
  fetchImpl?: typeof fetch;
}

function pickFetch(opts?: FetchOption): typeof fetch {
  return opts?.fetchImpl ?? fetch;
}

function normalizeAuthUser(data: unknown): AuthUser {
  const obj = (data ?? {}) as Record<string, unknown>;
  const nested = obj.user && typeof obj.user === "object"
    ? (obj.user as Record<string, unknown>)
    : null;
  const source = nested ?? obj;
  const user = { ...source };
  delete user.csrfToken;
  return user as AuthUser;
}

/**
 * POST /auth/register → 202 (no auto-login). On non-2xx, throws AuthApiError so
 * the UI can show the server message (e.g. email already used).
 */
export async function register(
  email: string,
  password: string,
  opts?: FetchOption,
): Promise<RegisterResult> {
  const res = await pickFetch(opts)(apiUrl("/auth/register"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw new AuthApiError(res.status, messageOf(data, "登録に失敗しました"));
  }
  return { ok: true, message: messageOf(data, "登録しました。") };
}

/**
 * POST /auth/login → 200 {user:{...}, csrfToken} + sets the HttpOnly session
 * cookie. Wrong creds → 401 (generic). Normalises the live nested `user` shape
 * while still accepting the legacy flat test/dev shape.
 */
export async function login(
  email: string,
  password: string,
  opts?: FetchOption,
): Promise<LoginResult> {
  const res = await pickFetch(opts)(apiUrl("/auth/login"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw new AuthApiError(
      res.status,
      res.status === 401
        ? "メールアドレスかパスワードが違います"
        : messageOf(data, "ログインに失敗しました"),
    );
  }
  const obj = (data ?? {}) as Record<string, unknown>;
  const csrfToken = obj.csrfToken;
  return {
    user: normalizeAuthUser(obj),
    csrfToken: typeof csrfToken === "string" ? csrfToken : "",
  };
}

/**
 * GET /auth/me → 200 {...user, csrfToken} (valid session) / 401. Returns the
 * user + the session's csrfToken on 200, null on 401, and throws only on
 * unexpected/network errors (so the gate can default to login rather than hang).
 *
 * The csrfToken is split out from the live nested user shape and carried
 * into AuthState so a reloaded-but-authed session can still send X-CSRF-Token on
 * logout — otherwise logout is silently rejected and the session is never
 * revoked server-side (logout-bypass on shared devices).
 */
export async function fetchMe(opts?: FetchOption): Promise<MeResult | null> {
  const res = await pickFetch(opts)(apiUrl("/auth/me"), {
    method: "GET",
    credentials: "include",
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new AuthApiError(res.status, "セッションの確認に失敗しました");
  }
  const obj = ((await safeJson(res)) ?? {}) as Record<string, unknown>;
  const csrfToken = obj.csrfToken;
  return {
    user: normalizeAuthUser(obj),
    csrfToken: typeof csrfToken === "string" ? csrfToken : "",
  };
}

/**
 * POST /auth/logout → clears the session. State-changing, so it sends the CSRF
 * token (from login) as X-CSRF-Token plus credentials (cookie) from our origin.
 */
export async function logout(csrfToken: string | null, opts?: FetchOption): Promise<void> {
  const headers: Record<string, string> = {};
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  await pickFetch(opts)(apiUrl("/auth/logout"), {
    method: "POST",
    credentials: "include",
    headers,
  });
  // We don't hard-fail logout on a non-2xx: the UI clears local state regardless
  // so the user always lands back on the login screen.
}

/** The Google OAuth entry point — a full-page navigation, not a fetch. */
export function googleStartUrl(): string {
  return apiUrl("/auth/google/start");
}

// ---- Google Calendar (Phase 1) ---------------------------------------------
//
// The calendar connection is a SEPARATE OAuth flow from login: the user may
// connect a DIFFERENT Google account than the one they logged in with. So the
// connect entry point is a full-page navigation (like login) that requires the
// session cookie (the Worker binds the calendar tokens to the logged-in user).
// status/plan/disconnect are credentialed fetches; plan/disconnect are
// state-changing → they also send X-CSRF-Token.

/** Full-page navigation that starts the SEPARATE calendar-connect OAuth flow.
 *  Requires an authenticated session (the SameSite=Lax cookie is sent on the
 *  top-level navigation). `redirect` is an optional safe relative landing path. */
export function calendarConnectUrl(redirect?: string): string {
  const base = apiUrl("/auth/google/calendar/start");
  return redirect ? `${base}?redirect=${encodeURIComponent(redirect)}` : base;
}

export interface CalendarStatus {
  connected: boolean;
  scopeOk: boolean;
  configured: boolean;
  /** The connected Google account email (may differ from the login account). */
  email: string | null;
}

/** GET /api/calendar/status — is the user's calendar connected (+ which account)? */
export async function calendarStatus(opts?: FetchOption): Promise<CalendarStatus> {
  const res = await pickFetch(opts)(apiUrl("/api/calendar/status"), {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) throw new AuthApiError(res.status, "カレンダー連携状態の取得に失敗しました");
  const d = ((await safeJson(res)) ?? {}) as Partial<CalendarStatus>;
  return {
    connected: d.connected === true,
    scopeOk: d.scopeOk === true,
    configured: d.configured === true,
    email: typeof d.email === "string" ? d.email : null,
  };
}

/** One event the coach planned (the client wire shape → Worker validates it). */
export interface CalendarPlanItemBody {
  type: "食事" | "トレーニング" | "タスク";
  title: string;
  start: string;
  end: string;
  notes?: string;
}

export interface CalendarPlanResult {
  created: { title: string; id: string; htmlLink?: string }[];
  failed: { title: string; reason: string }[];
  /** True when the grant died mid-batch (some created, then reconnect needed). */
  partial?: boolean;
  /** True when the API said the user isn't connected (UI prompts to connect). */
  notConnected?: boolean;
}

/**
 * POST /api/calendar/plan — create the planned events on the user's Google
 * Calendar. State-changing → credentials + X-CSRF-Token. A 409 maps to
 * notConnected (the UI then surfaces the connect button) rather than throwing.
 */
export async function calendarPlan(
  body: { items: CalendarPlanItemBody[]; timeZone?: string },
  csrfToken: string | null,
  opts?: FetchOption,
): Promise<CalendarPlanResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await pickFetch(opts)(apiUrl("/api/calendar/plan"), {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    return { created: [], failed: [], notConnected: true };
  }
  const data = await safeJson(res);
  if (!res.ok) {
    throw new AuthApiError(res.status, messageOf(data, "カレンダーへの登録に失敗しました"));
  }
  const obj = (data ?? {}) as Partial<CalendarPlanResult>;
  return {
    created: Array.isArray(obj.created) ? obj.created : [],
    failed: Array.isArray(obj.failed) ? obj.failed : [],
    ...(obj.partial ? { partial: true } : {}),
  };
}

/** One existing event read back from the user's calendar (day-planner). Times are
 *  echoed verbatim from Google: timed events carry RFC3339 start/end, all-day
 *  events carry YYYY-MM-DD with allDay:true. */
export interface CalendarTodayEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
}

export interface CalendarTodayResult {
  events: CalendarTodayEvent[];
  /** True when the API said the user isn't connected (the planner then asks them
   *  to connect their calendar — it never invents events). */
  notConnected: boolean;
}

/**
 * GET /api/calendar/today?timeMin=…&timeMax=… — READ the user's existing events
 * for the day window so the coach can plan around them. Read-only → no CSRF; the
 * session cookie is the auth (the Worker derives the user from the session — the
 * client never supplies a user/calendar id). A 409 maps to notConnected (the
 * planner then prompts to connect) rather than throwing. Other non-2xx throw so
 * the caller can omit events honestly (never fabricate a schedule).
 */
export async function calendarToday(
  window?: { timeMin?: string; timeMax?: string },
  opts?: FetchOption,
): Promise<CalendarTodayResult> {
  const qs = new URLSearchParams();
  if (window?.timeMin) qs.set("timeMin", window.timeMin);
  if (window?.timeMax) qs.set("timeMax", window.timeMax);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await pickFetch(opts)(apiUrl(`/api/calendar/today${suffix}`), {
    method: "GET",
    credentials: "include",
  });
  if (res.status === 409) {
    return { events: [], notConnected: true };
  }
  const data = await safeJson(res);
  if (!res.ok) {
    throw new AuthApiError(res.status, messageOf(data, "カレンダーの予定を取得できませんでした"));
  }
  const rawEvents = (data as { events?: unknown } | null)?.events;
  const events: CalendarTodayEvent[] = Array.isArray(rawEvents)
    ? rawEvents
        .map((e): CalendarTodayEvent | null => {
          if (!e || typeof e !== "object") return null;
          const o = e as Record<string, unknown>;
          if (typeof o.start !== "string" || typeof o.end !== "string") return null;
          return {
            summary: typeof o.summary === "string" ? o.summary : "",
            start: o.start,
            end: o.end,
            allDay: o.allDay === true,
          };
        })
        .filter((e): e is CalendarTodayEvent => e !== null)
    : [];
  return { events, notConnected: false };
}

/** POST /api/calendar/disconnect — unlink the calendar. State-changing → CSRF. */
export async function calendarDisconnect(csrfToken: string | null, opts?: FetchOption): Promise<void> {
  const headers: Record<string, string> = {};
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  await pickFetch(opts)(apiUrl("/api/calendar/disconnect"), {
    method: "POST",
    credentials: "include",
    headers,
  });
}

// ---- Web Push (Stage: notifications) ---------------------------------------
//
// Same cross-subdomain rules as the auth calls above: GET public-key is public
// (no cookie/CSRF needed), but subscribe/unsubscribe/test are state-changing →
// they send `credentials: "include"` (session cookie) + `X-CSRF-Token`.

/** The PushSubscription JSON the backend stores. `subscription.toJSON()` shape. */
export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Result of POST /api/push/test — how many pushes were sent / pruned (410 Gone). */
export interface PushTestResult {
  sent: number;
  gone: number;
}

/**
 * GET /api/push/public-key → { publicKey } (no auth). The VAPID application
 * server key the browser needs to create a subscription. Throws AuthApiError on
 * a non-2xx or a missing key so the UI can fall back to the bundled constant.
 */
export async function getVapidPublicKey(opts?: FetchOption): Promise<string> {
  const res = await pickFetch(opts)(apiUrl("/api/push/public-key"), {
    method: "GET",
    credentials: "include",
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw new AuthApiError(res.status, "通知キーの取得に失敗しました");
  }
  const key = (data as { publicKey?: unknown } | null)?.publicKey;
  if (typeof key !== "string" || !key) {
    throw new AuthApiError(res.status, "通知キーの取得に失敗しました");
  }
  return key;
}

/**
 * POST /api/push/subscribe — registers this browser's PushSubscription.
 * State-changing → credentials + X-CSRF-Token (same as logout).
 */
export async function pushSubscribe(
  body: PushSubscriptionBody,
  csrfToken: string | null,
  opts?: FetchOption,
): Promise<void> {
  const res = await pickFetch(opts)(apiUrl("/api/push/subscribe"), {
    method: "POST",
    credentials: "include",
    headers: pushHeaders(csrfToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new AuthApiError(res.status, "通知の登録に失敗しました");
  }
}

/**
 * POST /api/push/unsubscribe — removes this endpoint server-side.
 * State-changing → credentials + X-CSRF-Token.
 */
export async function pushUnsubscribe(
  body: { endpoint: string },
  csrfToken: string | null,
  opts?: FetchOption,
): Promise<void> {
  const res = await pickFetch(opts)(apiUrl("/api/push/unsubscribe"), {
    method: "POST",
    credentials: "include",
    headers: pushHeaders(csrfToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new AuthApiError(res.status, "通知の解除に失敗しました");
  }
}

/**
 * POST /api/push/test — sends a test push to the user's subscriptions.
 * Returns { sent, gone }. State-changing → credentials + X-CSRF-Token.
 */
export async function pushTest(
  csrfToken: string | null,
  opts?: FetchOption,
): Promise<PushTestResult> {
  const res = await pickFetch(opts)(apiUrl("/api/push/test"), {
    method: "POST",
    credentials: "include",
    headers: pushHeaders(csrfToken),
  });
  const data = await safeJson(res);
  if (!res.ok) {
    throw new AuthApiError(res.status, "テスト通知の送信に失敗しました");
  }
  const obj = (data ?? {}) as { sent?: unknown; gone?: unknown };
  return {
    sent: typeof obj.sent === "number" ? obj.sent : 0,
    gone: typeof obj.gone === "number" ? obj.gone : 0,
  };
}

/** Headers for the state-changing push POSTs: JSON + the CSRF token (when set). */
function pushHeaders(csrfToken: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return headers;
}

// ---- helpers ---------------------------------------------------------------

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function messageOf(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "message" in data) {
    const m = (data as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return fallback;
}

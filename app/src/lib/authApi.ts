// Thin client for the live auth backend (Stage 1).
//
// The app is served from your app host (e.g. https://app.example.com) and the
// API lives on a sibling host (e.g. https://api.example.com). Because it is a
// DIFFERENT origin, EVERY auth request must use `credentials: "include"` so the HttpOnly
// session cookie is sent/received. The browser attaches the Origin header
// automatically; the API CORS-allows our origin with credentials.
//
// State-changing requests (logout — and later the data PUT in Stage 2) also send
// `X-CSRF-Token: <csrfToken from login>`.
//
// Static-export-safe: this module has NO top-level window/localStorage access.

import type { AuthUser } from "./authState";

/**
 * Single source of truth for the API base URL. Set this for your deployment via
 * the NEXT_PUBLIC_HEALTH_API build-time env var (a one-line change for any env).
 * The default below is a neutral placeholder — self-hosters MUST set
 * NEXT_PUBLIC_HEALTH_API to their own API origin.
 */
export const HEALTH_API_BASE = (
  process.env.NEXT_PUBLIC_HEALTH_API ?? "https://<your-api-host>"
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
 * POST /auth/login → 200 {...user, csrfToken} + sets the HttpOnly session cookie.
 * Wrong creds → 401 (generic). Splits the user fields from csrfToken.
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
  const { csrfToken, ...user } = obj;
  return {
    user: user as AuthUser,
    csrfToken: typeof csrfToken === "string" ? csrfToken : "",
  };
}

/**
 * GET /auth/me → 200 {...user, csrfToken} (valid session) / 401. Returns the
 * user + the session's csrfToken on 200, null on 401, and throws only on
 * unexpected/network errors (so the gate can default to login rather than hang).
 *
 * The csrfToken is split out from the user fields (same as login) and carried
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
  const { csrfToken, ...user } = obj;
  return {
    user: user as AuthUser,
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

// Worker entry point + router. Responsibilities concentrated here so the
// security-relevant cross-cutting concerns (CORS, auth gate, CSRF gate) are in
// one auditable place and every route inherits them consistently.

import type { Env } from "./lib/env";
import { configError } from "./lib/env";
import {
  json,
  errorJson,
  preflight,
  withCors,
  parseCookies,
  SESSION_COOKIE,
} from "./lib/http";
import { resolveSession, touch } from "./lib/session";
import { checkCsrf, originAllowed } from "./lib/csrf";
import { makeGoogleVerifier } from "./lib/google";
import { handleRegister, handleLogin, handleLogout, handleMe } from "./routes/auth";
import { handleGoogleStart, handleGoogleCallback } from "./routes/oauth";
import { handleGetData, handlePutData } from "./routes/data";
import {
  handleGetPublicKey,
  handleSubscribe,
  handleUnsubscribe,
  handleTest,
} from "./routes/push";
import { purgeExpired } from "./lib/db";

/** Methods that mutate state → require Origin + CSRF token (when authenticated). */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  // CORS preflight.
  if (method === "OPTIONS") return preflight(req, env);

  // ---- Public auth endpoints ------------------------------------------------
  // register/login are state-changing but PRE-session: a double-submit CSRF
  // token can't exist yet, so the Origin/Referer check IS the CSRF gate here.
  // It is strict and FAIL-CLOSED: the request's Origin must equal APP_ORIGIN
  // (Referer is the only fallback), and a POST with neither header is rejected.
  // This blocks login-CSRF (an attacker silently logging the victim into the
  // attacker's account so the victim's data lands in it) and cross-site register.
  if (
    (pathname === "/auth/register" || pathname === "/auth/login") &&
    method === "POST"
  ) {
    if (!originAllowed(req, env)) {
      return errorJson("origin_not_allowed", "リクエスト元が許可されていません", 403);
    }
    return pathname === "/auth/register" ? handleRegister(req, env) : handleLogin(req, env);
  }
  if (pathname === "/auth/me" && method === "GET") {
    return handleMe(req, env);
  }

  // ---- Public push config ---------------------------------------------------
  // The VAPID public key is the browser's applicationServerKey; it ships to
  // every client anyway, so this needs no session/CSRF (read-only, no secret).
  if (pathname === "/api/push/public-key" && method === "GET") {
    return handleGetPublicKey(env);
  }

  // ---- Google OAuth (top-level navigations, not XHR) ------------------------
  // These are GET redirects driven by full-page navigation; state+PKCE+nonce are
  // the CSRF protection (not the cookie CSRF token). No CORS needed (navigation).
  if (pathname === "/auth/google/start" && method === "GET") {
    return handleGoogleStart(req, env);
  }
  if (pathname === "/auth/google/callback" && method === "GET") {
    return handleGoogleCallback(req, env, makeGoogleVerifier());
  }

  // ---- Authenticated endpoints ----------------------------------------------
  // Everything below requires a valid session. We resolve it once.
  const cookies = parseCookies(req);
  const resolved = await resolveSession(env, cookies[SESSION_COOKIE]);

  if (pathname === "/auth/logout" && method === "POST") {
    if (!resolved) return errorJson("unauthenticated", "ログインが必要です", 401);
    const csrfErr = checkCsrf(req, env, resolved.session.csrf_token);
    if (csrfErr) return errorJson("csrf_failed", "セッションの検証に失敗しました", 403);
    return handleLogout(env, resolved.session.id);
  }

  if (pathname === "/api/user/data") {
    if (!resolved) return errorJson("unauthenticated", "ログインが必要です", 401);

    // State-changing methods require the CSRF gate (Origin + token).
    if (STATE_CHANGING.has(method)) {
      const csrfErr = checkCsrf(req, env, resolved.session.csrf_token);
      if (csrfErr) return errorJson("csrf_failed", "セッションの検証に失敗しました", 403);
    }

    // Non-blocking "session seen" touch.
    await touch(env, resolved.session.id);

    if (method === "GET") return handleGetData(req, env, resolved.user.id);
    if (method === "PUT") return handlePutData(req, env, resolved.user.id);
    return errorJson("method_not_allowed", "許可されていないメソッドです", 405);
  }

  // ---- Web Push (authenticated; same session + CSRF gate as /api/user/data) --
  if (
    pathname === "/api/push/subscribe" ||
    pathname === "/api/push/unsubscribe" ||
    pathname === "/api/push/test"
  ) {
    if (!resolved) return errorJson("unauthenticated", "ログインが必要です", 401);
    if (method !== "POST") return errorJson("method_not_allowed", "許可されていないメソッドです", 405);

    // State-changing → CSRF gate (Origin + double-submit token), exactly as data.
    const csrfErr = checkCsrf(req, env, resolved.session.csrf_token);
    if (csrfErr) return errorJson("csrf_failed", "セッションの検証に失敗しました", 403);

    await touch(env, resolved.session.id);

    if (pathname === "/api/push/subscribe") return handleSubscribe(req, env, resolved.user.id);
    if (pathname === "/api/push/unsubscribe") return handleUnsubscribe(req, env, resolved.user.id);
    return handleTest(req, env, resolved.user.id);
  }

  if (pathname === "/health" && method === "GET") {
    return json({ ok: true });
  }

  return errorJson("not_found", "見つかりません", 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Fail-closed on an insecure production config (e.g. COOKIE_SECURE != "true"
    // in production). We refuse to serve rather than silently drop the Secure
    // cookie attribute over plaintext. Loud, generic 500 — no config detail leaked.
    const cfgErr = configError(env);
    if (cfgErr) {
      console.error("config_error", cfgErr);
      return withCors(errorJson("server_error", "サーバー設定エラーが発生しました", 500), req, env);
    }

    let res: Response;
    try {
      res = await route(req, env);
    } catch (err) {
      // Never leak internals. Log a coarse marker only (no PII, no secrets, no
      // request body). In Workers, console.error goes to the tail log only.
      console.error("unhandled_error", err instanceof Error ? err.name : "unknown");
      res = errorJson("server_error", "サーバーエラーが発生しました", 500);
    }
    // Apply CORS to every response (the helper only adds headers for the allowed
    // origin; non-browser / disallowed-origin callers simply get no CORS headers).
    return withCors(res, req, env);
  },

  // Cron-triggered GC of expired sessions + oauth_states (wrangler.toml
  // [triggers].crons). purgeExpired is also called opportunistically from
  // /auth/google/start; the cron guarantees expired rows are reaped even when
  // OAuth is idle, so neither table grows unbounded (DB-bloat DoS defense).
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgeExpired(env));
  },
} satisfies ExportedHandler<Env>;

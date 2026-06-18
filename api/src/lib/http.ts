// HTTP helpers: JSON responses, CORS (locked to the app origin, credentials on),
// and cookie serialization. Centralised so every handler is consistent and no
// endpoint accidentally widens CORS or drops a cookie flag.

import type { Env } from "./env";
import { cookieSecure } from "./env";

export const SESSION_COOKIE = "ha_session";
export const CSRF_COOKIE = "ha_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** JSON response with the standard headers (+ optional extra headers). */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  // Never let an auth response be cached by a shared cache.
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/**
 * Generic error response. The `code` is a stable machine token; `message` is a
 * short human string. We deliberately keep auth-related messages GENERIC (e.g.
 * "メールアドレスまたはパスワードが正しくありません") so we never reveal whether an
 * email exists. Never include stack traces, SQL, or secrets.
 */
export function errorJson(code: string, message: string, status: number, extraHeaders?: HeadersInit): Response {
  return json({ error: code, message }, { status, headers: extraHeaders });
}

// ---- CORS ------------------------------------------------------------------

/**
 * CORS headers locked to the configured app origin, with credentials enabled.
 * We ECHO the request Origin only if it EXACTLY equals env.APP_ORIGIN — we never
 * reflect an arbitrary origin and never use "*". With credentials, "*" is
 * forbidden by the browser anyway; an exact-match allow-list is the safe form.
 */
export function corsHeaders(req: Request, env: Env): Headers {
  const h = new Headers();
  const origin = req.headers.get("origin");
  if (origin && origin === env.APP_ORIGIN) {
    h.set("access-control-allow-origin", origin);
    h.set("access-control-allow-credentials", "true");
    h.set("vary", "origin");
    h.set("access-control-allow-headers", `content-type, ${CSRF_HEADER}`);
    h.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
    h.set("access-control-max-age", "600");
  }
  return h;
}

/** Merge CORS headers into an existing Response (preserving its body/status). */
export function withCors(res: Response, req: Request, env: Env): Response {
  const merged = new Headers(res.headers);
  for (const [k, v] of corsHeaders(req, env)) merged.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
}

/** Preflight response (no body). */
export function preflight(req: Request, env: Env): Response {
  const h = corsHeaders(req, env);
  return new Response(null, { status: 204, headers: h });
}

// ---- Cookies ---------------------------------------------------------------

interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

/**
 * Serialize a Set-Cookie value with security flags applied from env. Secure is
 * set in production (HTTPS); SameSite defaults to Lax (sends on top-level
 * navigations — needed for the OAuth redirect back — but blocks cross-site
 * sub-requests, the core CSRF mitigation). The session cookie is HttpOnly; the
 * CSRF cookie is NOT (the SPA must read it to echo it in the header).
 */
export function serializeCookie(name: string, value: string, env: Env, opts: CookieOptions = {}): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (env.COOKIE_DOMAIN) parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (cookieSecure(env)) parts.push("Secure");
  return parts.join("; ");
}

/** A Set-Cookie that clears a cookie. */
export function clearCookie(name: string, env: Env): string {
  return serializeCookie(name, "", env, { maxAgeSeconds: 0 });
}

/** Parse the Cookie header into a map. Tolerant of whitespace; never throws. */
export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.get("cookie");
  if (!raw) return out;
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// Email+password auth routes: register, login, logout, me.
//
// Security posture baked in here:
//   - generic auth errors (never reveal whether an email exists)
//   - per-IP + per-email rate limiting on register/login
//   - PBKDF2 password hashing (lib/crypto), never plaintext, never logged
//   - fresh session on every login (anti-fixation), HttpOnly+Secure+SameSite
//   - even when an email doesn't exist, login performs a dummy hash to keep the
//     response time ~constant (anti user-enumeration via timing)

import type { Env } from "../lib/env";
import {
  json,
  errorJson,
  serializeCookie,
  clearCookie,
  parseCookies,
  SESSION_COOKIE,
  CSRF_COOKIE,
} from "../lib/http";
import { sessionTtlSeconds } from "../lib/env";
import { hashPassword, verifyPassword, dummyVerify } from "../lib/crypto";
import { normalizeEmail, validatePassword, cleanDisplayName } from "../lib/validate";
import {
  getUserByEmail,
  insertPasswordUser,
  touchLogin,
} from "../lib/db";
import { createSession, resolveSession, revoke } from "../lib/session";
import {
  consume,
  reset,
  clientIp,
  LOGIN_IP_RULE,
  LOGIN_EMAIL_RULE,
  REGISTER_IP_RULE,
} from "../lib/ratelimit";

const GENERIC_AUTH_ERROR = "メールアドレスまたはパスワードが正しくありません";

/** Set both the HttpOnly session cookie and the readable CSRF cookie. */
function sessionCookies(env: Env, cookieValue: string, csrfToken: string): string[] {
  const maxAge = sessionTtlSeconds(env);
  return [
    serializeCookie(SESSION_COOKIE, cookieValue, env, { maxAgeSeconds: maxAge, httpOnly: true, sameSite: "Lax" }),
    // CSRF cookie is readable by the SPA so it can echo it in the header.
    serializeCookie(CSRF_COOKIE, csrfToken, env, { maxAgeSeconds: maxAge, httpOnly: false, sameSite: "Lax" }),
  ];
}

function setCookieHeaders(cookies: string[]): Headers {
  const h = new Headers();
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---- POST /auth/register ----------------------------------------------------

export async function handleRegister(req: Request, env: Env): Promise<Response> {
  const ip = clientIp(req);
  const ipLimit = await consume(env, `register:ip:${ip}`, REGISTER_IP_RULE);
  if (!ipLimit.allowed) {
    return errorJson("rate_limited", "登録の試行が多すぎます。しばらくしてからお試しください。", 429, {
      "retry-after": String(ipLimit.retryAfterSec),
    });
  }

  const body = await readJson(req);
  if (!body) return errorJson("bad_request", "リクエストが不正です", 400);

  const email = normalizeEmail(body.email);
  const pw = validatePassword(body.password);
  if (!email) return errorJson("invalid_email", "メールアドレスの形式が正しくありません", 400);
  if (!pw.ok) return errorJson("invalid_password", pw.reason, 400);

  const displayName = cleanDisplayName(body.displayName);

  // Anti-enumeration: register must NOT reveal whether the email already exists.
  // We therefore return ONE uniform "accepted" response (same status + same body)
  // whether the account is brand-new or the email is already taken — never a
  // 409-vs-201 oracle. We also do NOT auto-login on register: minting a session
  // here for an existing email would be account-takeover (the registrant may not
  // own that account), and granting a session only for new emails would itself be
  // the oracle. A real new user logs in (POST /auth/login) right after; once the
  // (deferred) email-verification flow lands, this is also where the confirm
  // email is sent. Hash FIRST so timing is ~equal regardless of existence.
  const record = await hashPassword(pw.value);

  const existing = await getUserByEmail(env, email);
  if (!existing) {
    const userId = crypto.randomUUID();
    try {
      await insertPasswordUser(env, {
        id: userId,
        email,
        passwordHash: record.hash,
        passwordSalt: record.salt,
        passwordAlgo: record.algo,
        displayName,
      });
    } catch {
      // Likely a race on the UNIQUE(email) index → fall through to the uniform
      // accepted response (do NOT leak the conflict).
    }
  }

  // Uniform response for BOTH new-account and already-taken-email cases.
  return json(
    { ok: true, message: "登録を受け付けました。ログインしてご利用ください。" },
    { status: 202 },
  );
}

// ---- POST /auth/login -------------------------------------------------------

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  const ip = clientIp(req);

  const body = await readJson(req);
  if (!body) return errorJson("bad_request", "リクエストが不正です", 400);

  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  // Per-IP throttle always; per-email throttle only when we have a parseable
  // email (so we can't be made to create unbounded buckets from garbage input).
  const ipLimit = await consume(env, `login:ip:${ip}`, LOGIN_IP_RULE);
  if (!ipLimit.allowed) {
    return errorJson("rate_limited", "試行が多すぎます。しばらくしてからお試しください。", 429, {
      "retry-after": String(ipLimit.retryAfterSec),
    });
  }
  if (email) {
    const emailLimit = await consume(env, `login:email:${email}`, LOGIN_EMAIL_RULE);
    if (!emailLimit.allowed) {
      return errorJson("rate_limited", "試行が多すぎます。しばらくしてからお試しください。", 429, {
        "retry-after": String(emailLimit.retryAfterSec),
      });
    }
  }

  const user = email ? await getUserByEmail(env, email) : null;

  // Anti-enumeration timing: ALWAYS perform an EQUAL-COST PBKDF2. When there is
  // no user (or it's an OAuth-only account with no password credential), we still
  // run a full dummy PBKDF2 (dummyVerify) so the response time is constant and
  // can't reveal whether the account exists or is OAuth-only. verifyPassword
  // would otherwise return early (no KDF) on a null record — exactly the leak.
  const record =
    user && user.password_hash && user.password_salt && user.password_algo
      ? { hash: user.password_hash, salt: user.password_salt, algo: user.password_algo }
      : null;
  const ok = record ? await verifyPassword(password, record) : await dummyVerify(password);

  if (!user || !record || !ok) {
    return errorJson("auth_failed", GENERIC_AUTH_ERROR, 401);
  }

  // Success → clear the per-email throttle, mint a FRESH session (anti-fixation).
  if (email) await reset(env, `login:email:${email}`);
  const session = await createSession(env, user.id, req.headers.get("user-agent"));
  await touchLogin(env, user.id);

  return json(
    { user: { id: user.id, email: user.email, displayName: user.display_name }, csrfToken: session.csrfToken },
    { status: 200, headers: setCookieHeaders(sessionCookies(env, session.cookieValue, session.csrfToken)) },
  );
}

// ---- POST /auth/logout ------------------------------------------------------
// CSRF is enforced by the router (state-changing + authenticated) before here.

export async function handleLogout(env: Env, sessionId: string): Promise<Response> {
  await revoke(env, sessionId);
  const headers = setCookieHeaders([clearCookie(SESSION_COOKIE, env), clearCookie(CSRF_COOKIE, env)]);
  return json({ ok: true }, { status: 200, headers });
}

// ---- GET /auth/me -----------------------------------------------------------

export async function handleMe(req: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(req);
  const resolved = await resolveSession(env, cookies[SESSION_COOKIE]);
  if (!resolved) return errorJson("unauthenticated", "ログインが必要です", 401);
  const { user, session } = resolved;
  return json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      emailVerified: user.email_verified === 1,
      hasPassword: !!user.password_hash,
      hasGoogle: !!user.google_sub,
    },
    // Re-surface the CSRF token so a freshly-loaded SPA can sync it.
    csrfToken: session.csrf_token,
  });
}

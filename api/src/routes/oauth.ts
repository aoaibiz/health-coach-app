// Google OAuth 2.0 / OIDC routes: start + callback.
//
//   GET  /auth/google/start    → 302 to Google with state + PKCE + nonce, all
//                                stored server-side in oauth_states (single-use).
//   GET  /auth/google/callback → validate state (anti-CSRF), exchange code (PKCE),
//                                FULLY verify the ID token, then map sub→user.
//
// Account-linking rule (anti account-takeover — hardened 2026-06-18):
//   - If a user already has this google_sub → log them in (they proved ownership
//     when the sub was first linked, so this is the only "already-linked" path).
//   - Else if Google asserts email_verified AND NO existing account has that
//     email → create a new Google-only account and log in.
//   - Else if an account ALREADY EXISTS for that email but is not linked to THIS
//     sub → REFUSE. We never auto-link a Google identity to a pre-existing
//     account and never grant a session for an account the user hasn't proven
//     they own. The only safe way to link is: log in with the password first,
//     THEN link Google while already authenticated (an authenticated-link flow,
//     not this unauthenticated callback). Auto-linking by email here is a
//     pre-account-takeover: an attacker who pre-registered a password account
//     under the victim's email would otherwise be handed the victim's Google
//     login (and vice-versa). So we return a clear "link required" state instead.
//   - We NEVER link by unverified email. Email alone is never a linking key — the
//     google_sub is, and a sub is only ever bound to an account the user proved
//     ownership of.

import type { Env } from "../lib/env";
import {
  json,
  errorJson,
  serializeCookie,
  SESSION_COOKIE,
  CSRF_COOKIE,
} from "../lib/http";
import { sessionTtlSeconds } from "../lib/env";
import { generatePkce, randomOpaque } from "../lib/crypto";
import { safeRelativePath } from "../lib/validate";
import {
  insertOAuthState,
  consumeOAuthState,
  getUserByGoogleSub,
  getUserByEmail,
  insertGoogleUser,
  touchLogin,
  purgeExpired,
  nowSec,
  type OAuthStateRow,
} from "../lib/db";
import { createSession } from "../lib/session";
import { consume, clientIp, OAUTH_START_IP_RULE } from "../lib/ratelimit";
import {
  buildAuthUrl,
  exchangeCode,
  type IdTokenVerifier,
} from "../lib/google";

const OAUTH_STATE_TTL_SEC = 600; // 10 min

function sessionCookies(env: Env, cookieValue: string, csrfToken: string): Headers {
  const maxAge = sessionTtlSeconds(env);
  const h = new Headers();
  h.append(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, cookieValue, env, { maxAgeSeconds: maxAge, httpOnly: true, sameSite: "Lax" }),
  );
  h.append(
    "set-cookie",
    serializeCookie(CSRF_COOKIE, csrfToken, env, { maxAgeSeconds: maxAge, httpOnly: false, sameSite: "Lax" }),
  );
  return h;
}

// ---- GET /auth/google/start -------------------------------------------------

export async function handleGoogleStart(req: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return errorJson("oauth_unavailable", "Googleログインは現在利用できません", 503);
  }

  // Rate-limit per IP: this endpoint is unauthenticated and writes an
  // oauth_states row on every call, so an attacker could otherwise flood the
  // table (DB-bloat DoS). CF-Connecting-IP only (never a client-supplied header).
  const ip = clientIp(req);
  const ipLimit = await consume(env, `oauth_start:ip:${ip}`, OAUTH_START_IP_RULE);
  if (!ipLimit.allowed) {
    return errorJson("rate_limited", "試行が多すぎます。しばらくしてからお試しください。", 429, {
      "retry-after": String(ipLimit.retryAfterSec),
    });
  }

  // Opportunistic GC of expired oauth_states + sessions so the tables don't grow
  // unbounded (purgeExpired had no caller before). Best-effort: never fail the
  // request if GC errors.
  try {
    await purgeExpired(env);
  } catch {
    // non-critical
  }

  const url = new URL(req.url);
  const redirectAfter = safeRelativePath(url.searchParams.get("redirect"));

  const state = randomOpaque();
  const nonce = randomOpaque();
  const { verifier, challenge } = await generatePkce();

  const row: OAuthStateRow = {
    state,
    code_verifier: verifier,
    nonce,
    redirect_after: redirectAfter,
    created_at: nowSec(),
    expires_at: nowSec() + OAUTH_STATE_TTL_SEC,
  };
  await insertOAuthState(env, row);

  const authUrl = buildAuthUrl(env, { state, codeChallenge: challenge, nonce });
  return new Response(null, { status: 302, headers: { location: authUrl } });
}

// ---- GET /auth/google/callback ----------------------------------------------

/** The callback handler takes the verifier (injectable for tests) + a fetch. */
export async function handleGoogleCallback(
  req: Request,
  env: Env,
  verifyIdToken: IdTokenVerifier,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return errorJson("oauth_unavailable", "Googleログインは現在利用できません", 503);
  }

  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) {
    // User denied / Google error. Generic, no detail echoed.
    return errorJson("oauth_failed", "Googleログインがキャンセルされました", 400);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return errorJson("oauth_failed", "Googleログインに失敗しました", 400);

  // Consume the state (single-use, anti-CSRF). Unknown/expired/replayed → reject.
  const stateRow = await consumeOAuthState(env, state);
  if (!stateRow) return errorJson("oauth_failed", "Googleログインに失敗しました", 400);
  if (stateRow.expires_at <= nowSec()) return errorJson("oauth_failed", "Googleログインの有効期限が切れました", 400);

  // Exchange the code (PKCE). Then verify the ID token (sig + iss/aud/exp/nonce).
  let claims;
  try {
    const tokens = await exchangeCode(env, code, stateRow.code_verifier, fetchImpl);
    if (!tokens.id_token) return errorJson("oauth_failed", "Googleログインに失敗しました", 400);
    claims = await verifyIdToken(tokens.id_token, stateRow.nonce, env);
  } catch {
    return errorJson("oauth_failed", "Googleログインに失敗しました", 400);
  }

  // ---- Resolve / create the account (the anti-takeover logic) ---------------
  // Only TWO paths grant a session: (a) this google_sub is already bound to an
  // account (ownership was proven at link time), or (b) we create a brand-new
  // Google-only account for an email no account uses yet. We NEVER auto-link to a
  // pre-existing account here and NEVER mint a session for an account the user
  // hasn't proven they own.
  let userId: string;

  const bySub = await getUserByGoogleSub(env, claims.sub);
  if (bySub) {
    // (a) Known sub → log in. This is the ONLY path that touches a pre-existing
    // account, and it's safe because the sub binding itself is the proof.
    userId = bySub.id;
  } else if (!claims.emailVerified || !claims.email) {
    // No verified email from Google → we can't create or match anything safely.
    return errorJson("oauth_failed", "Googleアカウントのメール確認が必要です", 400);
  } else {
    const byEmail = await getUserByEmail(env, claims.email);
    if (byEmail) {
      // An account already exists for this email but is NOT linked to this sub
      // (if it were, bySub would have matched). Auto-linking it would be a
      // pre-account-takeover, so we REFUSE and tell the client to link via the
      // authenticated path (log in with the password first, then link Google).
      // Crucially: no session is granted and no linkage is written here.
      return errorJson(
        "oauth_link_required",
        "このメールアドレスは既にアカウントが存在します。パスワードでログインしてからGoogle連携してください。",
        409,
      );
    }
    // (b) No existing account with this verified email → create a Google-only one.
    userId = crypto.randomUUID();
    await insertGoogleUser(env, {
      id: userId,
      email: claims.email,
      emailVerified: true,
      googleSub: claims.sub,
      displayName: claims.name,
    });
  }

  await touchLogin(env, userId);
  const session = await createSession(env, userId, req.headers.get("user-agent"));
  const headers = sessionCookies(env, session.cookieValue, session.csrfToken);

  // Land the browser back in the app. We bounce to the app origin (+ optional
  // validated relative path). The session cookie is set on this response.
  const landing = stateRow.redirect_after ?? "/";
  headers.set("location", `${env.APP_ORIGIN}${landing}`);
  return new Response(null, { status: 302, headers });
}

export { json };

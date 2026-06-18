// Session lifecycle. A session is an opaque server-side record; the browser only
// ever holds a random secret in an HttpOnly cookie. The DB stores the SHA-256
// HASH of that secret (a DB leak can't be replayed). The cookie value is
// "<sessionId>.<secret>": the id locates the row, the secret is verified
// (constant-time) against the stored hash.
//
// Anti-fixation: a brand-new session row (new id + new secret) is minted on
// every successful login; we never adopt a client-supplied session id.

import type { Env } from "./env";
import { sessionTtlSeconds } from "./env";
import {
  randomTokenBase64Url,
  randomOpaque,
  sha256Base64,
  timingSafeEqualStr,
} from "./crypto";
import {
  insertSession,
  getSessionById,
  deleteSession,
  touchSession,
  getUserById,
  nowSec,
  type SessionRow,
  type UserRow,
} from "./db";

export interface CreatedSession {
  /** The value to put in the session cookie ("<id>.<secret>"). */
  cookieValue: string;
  /** The CSRF token to put in the (readable) CSRF cookie + that the SPA echoes. */
  csrfToken: string;
  expiresAt: number;
}

/** Create a fresh session for a user (called on login / register / OAuth). */
export async function createSession(env: Env, userId: string, userAgent: string | null): Promise<CreatedSession> {
  const id = randomTokenBase64Url(16); // 128-bit session id
  const secret = randomTokenBase64Url(32); // 256-bit secret
  const csrfToken = randomOpaque();
  const tokenHash = await sha256Base64(secret);
  const expiresAt = nowSec() + sessionTtlSeconds(env);

  await insertSession(env, {
    id,
    userId,
    tokenHash,
    csrfToken,
    expiresAt,
    userAgent: userAgent ? userAgent.slice(0, 256) : null,
  });

  return { cookieValue: `${id}.${secret}`, csrfToken, expiresAt };
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

/**
 * Resolve + validate a session from the raw cookie value. Returns null on any
 * problem (malformed, unknown id, secret mismatch, expired, orphaned user) — the
 * caller treats null as "unauthenticated". Constant-time secret comparison; the
 * id is only an index lookup (knowing an id without the secret is useless).
 */
export async function resolveSession(env: Env, cookieValue: string | undefined): Promise<ResolvedSession | null> {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;
  const id = cookieValue.slice(0, dot);
  const secret = cookieValue.slice(dot + 1);
  if (!id || !secret) return null;

  const session = await getSessionById(env, id);
  if (!session) return null;

  // Expired? (server-side authority, independent of cookie Max-Age)
  if (session.expires_at <= nowSec()) {
    await deleteSession(env, id);
    return null;
  }

  // Verify the secret against the stored hash (constant-time).
  const presentedHash = await sha256Base64(secret);
  if (!timingSafeEqualStr(presentedHash, session.token_hash)) return null;

  const user = await getUserById(env, session.user_id);
  if (!user) {
    await deleteSession(env, id);
    return null;
  }

  return { session, user };
}

/** Best-effort "session has been seen" touch (updates last_seen_at). */
export async function touch(env: Env, sessionId: string): Promise<void> {
  try {
    await touchSession(env, sessionId);
  } catch {
    // last_seen_at is non-critical; never fail a request on it.
  }
}

/** Revoke a single session (logout). */
export async function revoke(env: Env, sessionId: string): Promise<void> {
  await deleteSession(env, sessionId);
}

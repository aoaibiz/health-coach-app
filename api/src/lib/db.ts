// Data-access layer. EVERY query uses D1 prepared statements with .bind() — no
// string interpolation of user input anywhere, so there is no SQL-injection
// surface. Each function is small + named so the security review can audit the
// full set of queries in one place.

import type { Env } from "./env";

export interface UserRow {
  id: string;
  email: string;
  email_verified: number;
  password_hash: string | null;
  password_salt: string | null;
  password_algo: string | null;
  google_sub: string | null;
  display_name: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
}

export interface OAuthStateRow {
  state: string;
  code_verifier: string;
  nonce: string;
  redirect_after: string | null;
  created_at: number;
  expires_at: number;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

// ---- users -----------------------------------------------------------------

export async function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE email = ?1").bind(email).first<UserRow>();
}

export async function getUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first<UserRow>();
}

export async function getUserByGoogleSub(env: Env, sub: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE google_sub = ?1").bind(sub).first<UserRow>();
}

export interface NewPasswordUser {
  id: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  passwordAlgo: string;
  displayName: string | null;
}

export async function insertPasswordUser(env: Env, u: NewPasswordUser): Promise<void> {
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_verified, password_hash, password_salt, password_algo,
                        google_sub, display_name, created_at, updated_at, last_login_at)
     VALUES (?1, ?2, 0, ?3, ?4, ?5, NULL, ?6, ?7, ?7, NULL)`,
  )
    .bind(u.id, u.email, u.passwordHash, u.passwordSalt, u.passwordAlgo, u.displayName, t)
    .run();
}

export interface NewGoogleUser {
  id: string;
  email: string;
  emailVerified: boolean;
  googleSub: string;
  displayName: string | null;
}

export async function insertGoogleUser(env: Env, u: NewGoogleUser): Promise<void> {
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_verified, password_hash, password_salt, password_algo,
                        google_sub, display_name, created_at, updated_at, last_login_at)
     VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?5, ?6, ?6, ?6)`,
  )
    .bind(u.id, u.email, u.emailVerified ? 1 : 0, u.googleSub, u.displayName, t)
    .run();
}

/** Link a Google sub to an EXISTING account. Reserved for the AUTHENTICATED
 *  link flow (user logs in with their password, THEN links Google while
 *  authenticated). It is intentionally NOT called from the unauthenticated OAuth
 *  callback: auto-linking by email there is a pre-account-takeover (see
 *  routes/oauth.ts). The `WHERE ... google_sub IS NULL` guard makes it a no-op if
 *  the account is already linked, so a linkage is never overwritten. */
export async function linkGoogleSub(env: Env, userId: string, googleSub: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE users SET google_sub = ?1, email_verified = 1, updated_at = ?2 WHERE id = ?3 AND google_sub IS NULL",
  )
    .bind(googleSub, nowSec(), userId)
    .run();
}

export async function touchLogin(env: Env, userId: string): Promise<void> {
  const t = nowSec();
  await env.DB.prepare("UPDATE users SET last_login_at = ?1, updated_at = ?1 WHERE id = ?2")
    .bind(t, userId)
    .run();
}

// ---- sessions ---------------------------------------------------------------

export interface NewSession {
  id: string;
  userId: string;
  tokenHash: string;
  csrfToken: string;
  expiresAt: number;
  userAgent: string | null;
}

export async function insertSession(env: Env, s: NewSession): Promise<void> {
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?7)`,
  )
    .bind(s.id, s.userId, s.tokenHash, s.csrfToken, t, s.expiresAt, s.userAgent)
    .run();
}

export async function getSessionById(env: Env, id: string): Promise<SessionRow | null> {
  return env.DB.prepare("SELECT * FROM sessions WHERE id = ?1").bind(id).first<SessionRow>();
}

export async function deleteSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(id).run();
}

export async function deleteAllSessionsForUser(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
}

export async function touchSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2").bind(nowSec(), id).run();
}

// ---- oauth_states -----------------------------------------------------------

export async function insertOAuthState(env: Env, row: OAuthStateRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauth_states (state, code_verifier, nonce, redirect_after, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(row.state, row.code_verifier, row.nonce, row.redirect_after, row.created_at, row.expires_at)
    .run();
}

/** Atomically consume a state row (single-use): returns it then deletes it. */
export async function consumeOAuthState(env: Env, state: string): Promise<OAuthStateRow | null> {
  const row = await env.DB.prepare("SELECT * FROM oauth_states WHERE state = ?1").bind(state).first<OAuthStateRow>();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?1").bind(state).run();
  return row;
}

// ---- user_data --------------------------------------------------------------

export async function getUserData(env: Env, userId: string, section: string): Promise<{ data: string; updated_at: number } | null> {
  return env.DB.prepare("SELECT data, updated_at FROM user_data WHERE user_id = ?1 AND section = ?2")
    .bind(userId, section)
    .first<{ data: string; updated_at: number }>();
}

export async function putUserData(env: Env, userId: string, section: string, dataJson: string): Promise<number> {
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO user_data (user_id, section, data, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id, section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(userId, section, dataJson, t)
    .run();
  return t;
}

// ---- push_subscriptions -----------------------------------------------------

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
}

/** Count a user's current subscriptions (enforce a per-user cap before insert). */
export async function countPushSubscriptions(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?1")
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** True if this endpoint is ALREADY a subscription of THIS user (so re-subscribing
 *  it is an in-place UPSERT, not new growth → must not be blocked by the cap). */
export async function userOwnsPushEndpoint(env: Env, userId: string, endpoint: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2",
  )
    .bind(userId, endpoint)
    .first<{ x: number }>();
  return !!row;
}

/** The owning user_id of an endpoint, or null if no row exists. Used by the
 *  subscribe route to decide insert vs same-user refresh vs cross-user conflict —
 *  an endpoint owned by a DIFFERENT user is NEVER reassigned. */
export async function getPushEndpointOwner(env: Env, endpoint: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?1")
    .bind(endpoint)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/**
 * UPSERT a subscription keyed by its (globally UNIQUE) endpoint, SCOPED to the
 * SAME user. The `ON CONFLICT(endpoint)` branch refreshes the keys but its
 * `WHERE user_id = excluded.user_id` guard makes a cross-user row a NO-OP: an
 * endpoint already owned by a DIFFERENT user is never reassigned or mutated here.
 * The subscribe route (routes/push.ts) checks ownership FIRST and returns 409 on
 * a cross-user conflict, so this guard is defense-in-depth. user_id always comes
 * from the session, never the client.
 */
export async function upsertPushSubscription(
  env: Env,
  s: { id: string; userId: string; endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  const t = nowSec();
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth
     WHERE push_subscriptions.user_id = excluded.user_id`,
  )
    .bind(s.id, s.userId, s.endpoint, s.p256dh, s.auth, t)
    .run();
}

/** All of a user's subscriptions (the /api/push/test fan-out). */
export async function getPushSubscriptionsForUser(env: Env, userId: string): Promise<PushSubscriptionRow[]> {
  const res = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?1")
    .bind(userId)
    .all<PushSubscriptionRow>();
  return res.results ?? [];
}

/** Delete a subscription by endpoint, SCOPED to the user (a user can only delete
 *  their own row — never another user's endpoint). */
export async function deletePushSubscription(env: Env, userId: string, endpoint: string): Promise<void> {
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2")
    .bind(userId, endpoint)
    .run();
}

// ---- maintenance (best-effort GC of expired rows) ---------------------------

export async function purgeExpired(env: Env): Promise<void> {
  const t = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(t),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?1").bind(t),
  ]);
}

// D1-backed fixed-window rate limiter (brute-force / credential-stuffing
// defense). Keyed by an action + dimension + value bucket, e.g.
//   "login:ip:203.0.113.5"  and  "login:email:a@b.com".
// We check BOTH the per-IP and per-email buckets on login/register so neither a
// single IP hammering many emails nor many IPs hammering one email gets through.
//
// Workers has no built-in per-key rate limiter on the free tier, and KV is
// eventually-consistent; D1 gives us a strongly-consistent counter, which is the
// right primitive for "did this exact bucket exceed N in the last window".
//
// This is intentionally simple + correct (a fixed window with a lockout). It is
// NOT a distributed token bucket; for higher scale a Durable Object or the
// Cloudflare Rate Limiting binding would replace this module behind the same
// interface — noted as a deliberate later-stage upgrade.

import type { Env } from "./env";
import { nowSec } from "./db";

export interface RateLimitRule {
  /** Max attempts allowed within the window. */
  max: number;
  /** Window length in seconds. */
  windowSec: number;
  /** How long to lock out once the max is exceeded, in seconds. */
  lockoutSec: number;
}

export const LOGIN_IP_RULE: RateLimitRule = { max: 20, windowSec: 600, lockoutSec: 900 };
export const LOGIN_EMAIL_RULE: RateLimitRule = { max: 8, windowSec: 600, lockoutSec: 900 };
export const REGISTER_IP_RULE: RateLimitRule = { max: 10, windowSec: 3600, lockoutSec: 3600 };
// /auth/google/start is unauthenticated and writes an oauth_states row each call;
// throttle per-IP so it can't be used to flood the table (DB-bloat DoS).
export const OAUTH_START_IP_RULE: RateLimitRule = { max: 30, windowSec: 600, lockoutSec: 600 };

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry (only meaningful when !allowed). */
  retryAfterSec: number;
}

/**
 * Consume one attempt against `bucket`. Returns allowed=false (with a
 * Retry-After) when the bucket is locked out or this attempt would exceed the
 * rule. Uses a read-modify-write; D1 is strongly consistent per-DB so concurrent
 * requests to the same bucket serialize correctly enough for an auth throttle.
 */
export async function consume(env: Env, bucket: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const t = nowSec();
  const row = await env.DB.prepare("SELECT count, window_start, blocked_until FROM rate_limit WHERE bucket = ?1")
    .bind(bucket)
    .first<{ count: number; window_start: number; blocked_until: number | null }>();

  // Locked out?
  if (row?.blocked_until && row.blocked_until > t) {
    return { allowed: false, retryAfterSec: row.blocked_until - t };
  }

  // No row, or the window has expired → start a fresh window at count 1.
  if (!row || t - row.window_start >= rule.windowSec) {
    await env.DB.prepare(
      `INSERT INTO rate_limit (bucket, count, window_start, blocked_until) VALUES (?1, 1, ?2, NULL)
       ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = ?2, blocked_until = NULL`,
    )
      .bind(bucket, t)
      .run();
    return { allowed: true, retryAfterSec: 0 };
  }

  const next = row.count + 1;
  if (next > rule.max) {
    // Exceeded → set lockout.
    const blockedUntil = t + rule.lockoutSec;
    await env.DB.prepare("UPDATE rate_limit SET count = ?1, blocked_until = ?2 WHERE bucket = ?3")
      .bind(next, blockedUntil, bucket)
      .run();
    return { allowed: false, retryAfterSec: rule.lockoutSec };
  }

  await env.DB.prepare("UPDATE rate_limit SET count = ?1 WHERE bucket = ?2").bind(next, bucket).run();
  return { allowed: true, retryAfterSec: 0 };
}

/** Reset a bucket (e.g. clear the per-email counter after a SUCCESSFUL login so
 *  a legitimate user isn't penalised by earlier typos). */
export async function reset(env: Env, bucket: string): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limit WHERE bucket = ?1").bind(bucket).run();
}

/** Client IP for rate-limiting. We use ONLY `CF-Connecting-IP`, which is set by
 *  the Cloudflare edge and CANNOT be spoofed by the client when the Worker is
 *  fronted by Cloudflare. We deliberately do NOT fall back to any client-supplied
 *  header (e.g. `X-Real-IP` / `X-Forwarded-For`): trusting those lets an attacker
 *  forge a fresh IP per request and bypass the per-IP limiter entirely. When the
 *  trusted header is absent, all such requests share a single `"unknown"` bucket
 *  — still throttled, never bypassable — rather than getting per-attacker buckets. */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || "unknown";
}

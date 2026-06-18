// CSRF protection for state-changing requests (POST/PUT/DELETE).
//
// Layered defense (defense-in-depth):
//   1. SameSite=Lax session cookie — the browser won't send it on cross-site
//      sub-requests (the primary CSRF mitigation).
//   2. Origin/Referer check — the request's Origin must equal the app origin.
//   3. Double-submit token — the SPA reads the (non-HttpOnly) CSRF cookie and
//      echoes it in the X-CSRF-Token header; we require it to equal the token
//      bound to the resolved session (server-side), compared constant-time.
//
// All three must pass. A cross-site attacker can't read the CSRF cookie (CORS /
// no allowed origin) nor set the custom header on a forged top-level navigation.

import type { Env } from "./env";
import { CSRF_HEADER } from "./http";
import { timingSafeEqualStr } from "./crypto";

/** True if the request's Origin (or Referer, as a fallback) is the app origin. */
export function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === env.APP_ORIGIN;
  // Some legitimate same-origin requests omit Origin; fall back to Referer.
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === env.APP_ORIGIN;
    } catch {
      return false;
    }
  }
  // No Origin and no Referer on a state-changing request → reject.
  return false;
}

/**
 * Validate CSRF for a state-changing request given the session's bound token.
 * Requires: origin allowed AND the X-CSRF-Token header equals the session's
 * csrf_token (constant-time). Returns a reason string on failure, null on pass.
 */
export function checkCsrf(req: Request, env: Env, sessionCsrfToken: string): string | null {
  if (!originAllowed(req, env)) return "origin_not_allowed";
  const header = req.headers.get(CSRF_HEADER);
  if (!header) return "csrf_token_missing";
  if (!timingSafeEqualStr(header, sessionCsrfToken)) return "csrf_token_mismatch";
  return null;
}

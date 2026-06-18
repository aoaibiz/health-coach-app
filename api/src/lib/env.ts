// The Worker environment binding shape. Non-secret config comes from
// wrangler.toml [vars]; SECRETS come from `wrangler secret put` (prod) or
// .dev.vars (local) and are listed in SECRETS.md (names only).

export interface Env {
  // --- Bindings ---
  DB: D1Database;

  // --- Non-secret config (wrangler.toml [vars]) ---
  APP_ORIGIN: string; // exact origin allowed by CORS, e.g. https://app.example.com
  API_ORIGIN: string; // this Worker's public origin (used to build the OAuth redirect_uri)
  GOOGLE_REDIRECT_PATH: string; // e.g. /auth/google/callback
  COOKIE_DOMAIN: string; // "" for host-only cookie (local), ".example.com" in prod
  COOKIE_SECURE: string; // "true" in prod (HTTPS); "false" for http://localhost dev
  SESSION_TTL_SECONDS: string; // session lifetime in seconds
  ENVIRONMENT: string; // "development" | "production"

  // Web Push (VAPID) — the public key + contact subject are NON-secret config
  // (wrangler.toml [vars]); the public key ships to the browser anyway.
  VAPID_PUBLIC_KEY: string; // base64url uncompressed P-256 public key (the VAPID applicationServerKey)
  VAPID_SUBJECT: string; // "mailto:..." contact, sent in the VAPID JWT `sub`

  // --- SECRETS (never in code/git; injected via wrangler secret / .dev.vars) ---
  // Google OAuth 2.0 / OIDC web client credentials:
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // VAPID EC P-256 private key as a JSON JWK string {kty:"EC",crv:"P-256",x,y,d}.
  // True secret (the signing key) — set via `wrangler secret put`, never in git.
  VAPID_PRIVATE_JWK: string;
}

/** True when the running environment is production. */
export function isProduction(env: Env): boolean {
  return env.ENVIRONMENT === "production";
}

/**
 * Whether to set the cookie `Secure` attribute. FAIL-CLOSED in production: in
 * prod we ALWAYS set Secure regardless of COOKIE_SECURE, so a config typo can
 * never ship session/CSRF cookies over plaintext. Outside prod, Secure follows
 * COOKIE_SECURE (so http://localhost dev still receives the cookie).
 */
export function cookieSecure(env: Env): boolean {
  if (isProduction(env)) return true;
  return env.COOKIE_SECURE === "true";
}

/**
 * Fail-closed config guard. A production deploy with COOKIE_SECURE !== "true" is
 * a misconfiguration: it signals an intent to drop Secure in prod, which we
 * refuse. Returns an error string to surface (the entrypoint rejects the request
 * with a clear 500) so the misconfig is loud, never silent. null = config OK.
 */
export function configError(env: Env): string | null {
  if (isProduction(env) && env.COOKIE_SECURE !== "true") {
    return "insecure_cookie_config_in_production";
  }
  return null;
}

export function sessionTtlSeconds(env: Env): number {
  const n = Number(env.SESSION_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 2_592_000; // 30d default
}

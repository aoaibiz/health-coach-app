// Google OAuth 2.0 / OIDC. Two responsibilities:
//   1. Build the authorization-redirect URL (with state + PKCE + nonce).
//   2. Exchange the code and FULLY VERIFY the returned ID token: RS256 signature
//      against Google's JWKS, plus iss / aud / exp / iat / nonce. We never trust
//      the token's claims (esp. email/sub) until the signature + claims check.
//
// Account-linking rule lives in the callback route, not here: we only return the
// verified claims. The key fields are `sub` (stable Google account id — the
// linking key) and `email` + `email_verified` (used only when Google asserts the
// email is verified, and even then never as the sole linking key).
//
// Everything runs on Workers-native fetch + Web Crypto (RS256 verify via
// crypto.subtle.importKey JWK + verify). No external JWT library.

import type { Env } from "./env";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
// Google's accepted issuer values.
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** Clock-skew tolerance when checking exp/iat (seconds). */
const SKEW_SEC = 120;

export interface GoogleClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export function redirectUri(env: Env): string {
  return `${env.API_ORIGIN}${env.GOOGLE_REDIRECT_PATH}`;
}

/** Build the Google authorization URL the user is sent to. */
export function buildAuthUrl(env: Env, opts: { state: string; codeChallenge: string; nonce: string }): string {
  if (!env.GOOGLE_CLIENT_ID) throw new Error("google_oauth_not_configured");
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri(env));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("nonce", opts.nonce);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  // Prompt selection each time; don't silently reuse a prior grant.
  u.searchParams.set("access_type", "online");
  u.searchParams.set("include_granted_scopes", "false");
  return u.toString();
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
}

/** Exchange the authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCode(
  env: Env,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("google_oauth_not_configured");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(env),
    code_verifier: codeVerifier,
  });
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return (await res.json()) as TokenResponse;
}

// ---- ID token (JWS) verification -------------------------------------------

interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg?: string;
  kty: string;
}

/** Verifier interface so the callback route can inject a mock in tests (no
 *  network, no real Google). The production impl fetches Google's JWKS. */
export type IdTokenVerifier = (idToken: string, expectedNonce: string, env: Env) => Promise<GoogleClaims>;

/** Fetch Google's JWKS (route caches per-request; could add edge cache later). */
async function fetchJwks(fetchImpl: typeof fetch): Promise<Jwk[]> {
  const res = await fetchImpl(GOOGLE_JWKS_URL);
  const data = (await res.json()) as { keys?: Jwk[] };
  return data.keys ?? [];
}

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJwtPart<T>(part: string): T {
  const bytes = b64urlToBytes(part);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Production ID-token verifier. Full OIDC validation:
 *   - parse header → find the matching JWKS key by kid; require alg RS256
 *   - verify the RS256 signature over header.payload with the JWK
 *   - iss ∈ Google issuers; aud === our client_id; exp/iat within skew
 *   - nonce === the nonce we generated for this flow
 * Throws on ANY failure (callers map to a generic error). Returns verified claims.
 */
export function makeGoogleVerifier(fetchImpl: typeof fetch = fetch): IdTokenVerifier {
  return async (idToken, expectedNonce, env) => {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("idtoken_malformed");
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    const header = decodeJwtPart<{ alg?: string; kid?: string }>(headerB64);
    if (header.alg !== "RS256") throw new Error("idtoken_bad_alg");
    if (!header.kid) throw new Error("idtoken_no_kid");

    const jwks = await fetchJwks(fetchImpl);
    const jwk = jwks.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) throw new Error("idtoken_unknown_kid");

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = b64urlToBytes(sigB64);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signedData);
    if (!ok) throw new Error("idtoken_bad_signature");

    const payload = decodeJwtPart<{
      iss?: string;
      aud?: string;
      sub?: string;
      exp?: number;
      iat?: number;
      nonce?: string;
      email?: string;
      email_verified?: boolean | string;
      name?: string;
    }>(payloadB64);

    if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) throw new Error("idtoken_bad_iss");
    if (!payload.aud || payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error("idtoken_bad_aud");
    if (!payload.sub) throw new Error("idtoken_no_sub");

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp + SKEW_SEC < now) throw new Error("idtoken_expired");
    if (typeof payload.iat === "number" && payload.iat - SKEW_SEC > now) throw new Error("idtoken_future_iat");

    if (!payload.nonce || payload.nonce !== expectedNonce) throw new Error("idtoken_bad_nonce");

    const emailVerified = payload.email_verified === true || payload.email_verified === "true";
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null,
      emailVerified,
      name: typeof payload.name === "string" ? payload.name : null,
    };
  };
}

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleGoogleStart, handleGoogleCallback } from "../src/routes/oauth";
import { makeGoogleVerifier, type GoogleClaims, type IdTokenVerifier } from "../src/lib/google";
import { consumeOAuthState, getUserByGoogleSub, getUserByEmail, insertPasswordUser, nowSec } from "../src/lib/db";
import { hashPassword } from "../src/lib/crypto";

// The OAuth routes need Google client creds to be "configured". The test env
// (wrangler.toml [vars]) has none, so we pass an env clone with placeholders.
// These are NON-SECRET test placeholders, not real credentials.
const oauthEnv = () => ({ ...env, GOOGLE_CLIENT_ID: "test-client-id", GOOGLE_CLIENT_SECRET: "test-client-secret" });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM sessions");
  await env.DB.exec("DELETE FROM oauth_states");
  await env.DB.exec("DELETE FROM rate_limit");
});

/** A fetch stub that returns a token response (the code exchange). */
function tokenFetch(idToken: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ id_token: idToken, access_token: "at" }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** A mock verifier that returns fixed claims (no signature check) — for route
 *  logic tests. The PRODUCTION verifier is tested separately below. */
function mockVerifier(claims: GoogleClaims): IdTokenVerifier {
  return async (_idToken, _nonce, _env) => claims;
}

describe("OAuth start", () => {
  it("302-redirects to Google and persists a single-use state", async () => {
    const res = await handleGoogleStart(new Request("https://api.test/auth/google/start"), oauthEnv() as any);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("accounts.google.com");
    const u = new URL(loc);
    const state = u.searchParams.get("state")!;
    expect(state).toBeTruthy();
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("nonce")).toBeTruthy();
    // The state must exist in the DB (server-side, single-use).
    const row = await consumeOAuthState(env, state);
    expect(row).toBeTruthy();
    expect(row!.code_verifier).toBeTruthy();
    expect(row!.nonce).toBe(u.searchParams.get("nonce"));
  });

  it("is unavailable (503) when Google creds are not configured", async () => {
    const res = await handleGoogleStart(new Request("https://api.test/auth/google/start"), env as any);
    expect(res.status).toBe(503);
  });

  it("is RATE-LIMITED per IP (finding #6 — anti oauth_states flood / DB-bloat)", async () => {
    // OAUTH_START_IP_RULE.max = 30; the (max+1)-th call from the same bucket
    // (no cf-connecting-ip → shared "unknown") must be 429 with a retry-after.
    let saw429 = false;
    for (let i = 0; i < 32; i++) {
      const res = await handleGoogleStart(new Request("https://api.test/auth/google/start"), oauthEnv() as any);
      if (res.status === 429) {
        saw429 = true;
        expect(res.headers.get("retry-after")).toBeTruthy();
        expect(((await res.json()) as any).error).toBe("rate_limited");
        break;
      }
      expect(res.status).toBe(302);
    }
    expect(saw429).toBe(true);
  });

  it("INVOKES purgeExpired: a stale oauth_states row is reaped on start (finding #6)", async () => {
    // Seed an already-expired state row directly.
    await env.DB.prepare(
      `INSERT INTO oauth_states (state, code_verifier, nonce, redirect_after, created_at, expires_at)
       VALUES (?1, ?2, ?3, NULL, ?4, ?5)`,
    )
      .bind("stale-state", "v", "n", nowSec() - 10_000, nowSec() - 5_000)
      .run();
    const before = await env.DB.prepare("SELECT COUNT(*) AS c FROM oauth_states WHERE state = 'stale-state'").first<{ c: number }>();
    expect(before!.c).toBe(1);

    const res = await handleGoogleStart(new Request("https://api.test/auth/google/start"), oauthEnv() as any);
    expect(res.status).toBe(302);

    // purgeExpired ran opportunistically → the stale row is gone.
    const after = await env.DB.prepare("SELECT COUNT(*) AS c FROM oauth_states WHERE state = 'stale-state'").first<{ c: number }>();
    expect(after!.c).toBe(0);
  });
});

describe("OAuth callback — state (anti-CSRF) validation", () => {
  it("rejects a callback with an unknown / forged state", async () => {
    const res = await handleGoogleCallback(
      new Request("https://api.test/auth/google/callback?code=abc&state=forged-state"),
      oauthEnv() as any,
      mockVerifier({ sub: "g1", email: "x@example.com", emailVerified: true, name: "X" }),
      tokenFetch("idtok"),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("oauth_failed");
  });

  it("rejects a missing code or state", async () => {
    const res = await handleGoogleCallback(
      new Request("https://api.test/auth/google/callback?state=onlystate"),
      oauthEnv() as any,
      mockVerifier({ sub: "g1", email: "x@example.com", emailVerified: true, name: null }),
      tokenFetch("idtok"),
    );
    expect(res.status).toBe(400);
  });

  it("a state is single-use: replaying it after a successful callback fails", async () => {
    // Seed a valid flow via start.
    const start = await handleGoogleStart(new Request("https://api.test/auth/google/start"), oauthEnv() as any);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;

    const cb = await handleGoogleCallback(
      new Request(`https://api.test/auth/google/callback?code=goodcode&state=${state}`),
      oauthEnv() as any,
      mockVerifier({ sub: "sub-123", email: "new@example.com", emailVerified: true, name: "New" }),
      tokenFetch("idtok"),
    );
    expect(cb.status).toBe(302); // success → redirect back to app
    // Replay the same state → it was consumed, so now it's unknown → 400.
    const replay = await handleGoogleCallback(
      new Request(`https://api.test/auth/google/callback?code=goodcode&state=${state}`),
      oauthEnv() as any,
      mockVerifier({ sub: "sub-123", email: "new@example.com", emailVerified: true, name: "New" }),
      tokenFetch("idtok"),
    );
    expect(replay.status).toBe(400);
  });
});

describe("OAuth callback — account creation / linking (anti-takeover)", () => {
  async function freshState(): Promise<string> {
    const start = await handleGoogleStart(new Request("https://api.test/auth/google/start"), oauthEnv() as any);
    return new URL(start.headers.get("location")!).searchParams.get("state")!;
  }

  it("creates a NEW google-only account when no account has that sub or email", async () => {
    const state = await freshState();
    const res = await handleGoogleCallback(
      new Request(`https://api.test/auth/google/callback?code=c&state=${state}`),
      oauthEnv() as any,
      mockVerifier({ sub: "brand-new-sub", email: "fresh@example.com", emailVerified: true, name: "Fresh" }),
      tokenFetch("idtok"),
    );
    expect(res.status).toBe(302);
    const user = await getUserByGoogleSub(env, "brand-new-sub");
    expect(user).toBeTruthy();
    expect(user!.email).toBe("fresh@example.com");
    expect(user!.email_verified).toBe(1);
  });

  it("REFUSES to auto-link Google to an existing password account (anti pre-account-takeover); no link, no session", async () => {
    // CRITICAL (finding #1): an existing password account for this email must NOT
    // be auto-linked when a Google login arrives — even with a verified, matching
    // email. The safe path is "log in with password, then link while authed".
    const rec = await hashPassword("password123");
    const uid = crypto.randomUUID();
    await insertPasswordUser(env, {
      id: uid,
      email: "linkme@example.com",
      passwordHash: rec.hash,
      passwordSalt: rec.salt,
      passwordAlgo: rec.algo,
      displayName: null,
    });

    const state = await freshState();
    const res = await handleGoogleCallback(
      new Request(`https://api.test/auth/google/callback?code=c&state=${state}`),
      oauthEnv() as any,
      mockVerifier({ sub: "would-link-sub", email: "linkme@example.com", emailVerified: true, name: "Link" }),
      tokenFetch("idtok"),
    );
    // Refused with a clear "link required" state — NOT a 302 (no session granted).
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe("oauth_link_required");
    // The password account must remain UNLINKED, and no account got the sub.
    const stillUnlinked = await env.DB.prepare("SELECT google_sub FROM users WHERE id = ?1")
      .bind(uid)
      .first<{ google_sub: string | null }>();
    expect(stillUnlinked!.google_sub).toBeNull();
    expect(await getUserByGoogleSub(env, "would-link-sub")).toBeNull();
    // No Set-Cookie / no session leaked into the attacker- or victim-owned account.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("ATTACKER pre-registers the victim's email (password) → victim's Google login does NOT take over / share that account", async () => {
    // Full adversarial scenario for finding #1. The attacker registers a password
    // account under the victim's email (so the attacker knows the password and the
    // account has email_verified=0). Then the VICTIM does a normal Google login
    // (Google asserts email_verified=true for the victim's own email). The old
    // code would link the victim's google_sub into the ATTACKER's account and hand
    // the victim a session there → silent shared/takeover. Now it must refuse.
    const SELF = (await import("cloudflare:test")).SELF;
    const ORIGIN = "http://localhost:3000";
    // 1) Attacker registers the victim's email with a password.
    const reg = await SELF.fetch(
      new Request("https://api.test/auth/register", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: "victim@example.com", password: "attackerKnows1" }),
      }),
    );
    expect(reg.status).toBe(202); // accepted, no session
    const attackerAccount = await getUserByEmail(env, "victim@example.com");
    expect(attackerAccount).toBeTruthy();
    expect(attackerAccount!.google_sub).toBeNull();

    // 2) Victim does Google login (verified, matching email, a DIFFERENT sub).
    const state = await freshState();
    const cb = await handleGoogleCallback(
      new Request(`https://api.test/auth/google/callback?code=c&state=${state}`),
      oauthEnv() as any,
      mockVerifier({ sub: "victim-google-sub", email: "victim@example.com", emailVerified: true, name: "Victim" }),
      tokenFetch("idtok"),
    );

    // 3) Must be refused: no session, no link into the attacker's account.
    expect(cb.status).toBe(409);
    expect(((await cb.json()) as any).error).toBe("oauth_link_required");
    expect(cb.headers.get("set-cookie")).toBeNull();
    // The attacker's account is untouched (still no google_sub, same id).
    const after = await getUserByEmail(env, "victim@example.com");
    expect(after!.id).toBe(attackerAccount!.id);
    expect(after!.google_sub).toBeNull();
    // The victim's google_sub was NOT bound to ANY account.
    expect(await getUserByGoogleSub(env, "victim-google-sub")).toBeNull();
  });

  it("does NOT link by an UNVERIFIED email (rejects rather than take over)", async () => {
    const rec = await hashPassword("password123");
    const uid = crypto.randomUUID();
    await insertPasswordUser(env, {
      id: uid,
      email: "victim@example.com",
      passwordHash: rec.hash,
      passwordSalt: rec.salt,
      passwordAlgo: rec.algo,
      displayName: null,
    });

    const state = await freshState();
    const res = await handleGoogleCallback(
      new Request(`https://api.test/auth/google/callback?code=c&state=${state}`),
      oauthEnv() as any,
      // emailVerified=false → must NOT link to the existing victim account.
      mockVerifier({ sub: "attacker-sub", email: "victim@example.com", emailVerified: false, name: "Attacker" }),
      tokenFetch("idtok"),
    );
    expect(res.status).toBe(400); // rejected (needs verified email)
    // The victim account must remain UNLINKED.
    const stillUnlinked = await env.DB.prepare("SELECT google_sub FROM users WHERE id = ?1")
      .bind(uid)
      .first<{ google_sub: string | null }>();
    expect(stillUnlinked!.google_sub).toBeNull();
    // No account got the attacker's sub.
    expect(await getUserByGoogleSub(env, "attacker-sub")).toBeNull();
  });
});

describe("production ID-token verifier rejects tampered tokens", () => {
  it("rejects a malformed token", async () => {
    const verify = makeGoogleVerifier();
    await expect(verify("not-a-jwt", "nonce", oauthEnv() as any)).rejects.toThrow();
  });

  it("rejects a token with a non-RS256 alg (e.g. the 'alg:none' attack)", async () => {
    const verify = makeGoogleVerifier();
    // header {alg:none}, payload {sub:evil,...}, empty sig
    const b64 = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const forged = `${b64({ alg: "none" })}.${b64({ sub: "evil", aud: "test-client-id", iss: "https://accounts.google.com", exp: nowSec() + 3600, nonce: "n" })}.`;
    await expect(verify(forged, "n", oauthEnv() as any)).rejects.toThrow();
  });
});

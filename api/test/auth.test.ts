import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { setCookies, getCookie } from "./helpers";

// End-to-end auth flow against the REAL Worker (SELF.fetch) + REAL local D1.
// APP_ORIGIN in the test env is http://localhost:3000 (from wrangler.toml [vars]).
const ORIGIN = "http://localhost:3000";

function jsonReq(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const getSetCookie = getCookie;

/** Build a Cookie header from a session + csrf value. */
function cookieHeader(session: string | null, csrf: string | null): string {
  const parts: string[] = [];
  if (session) parts.push(`ha_session=${session}`);
  if (csrf) parts.push(`ha_csrf=${csrf}`);
  return parts.join("; ");
}

// Each test file gets isolated D1 storage; clear users between tests so emails
// don't collide across cases within this file.
beforeEach(async () => {
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM sessions");
  await env.DB.exec("DELETE FROM rate_limit");
});

/** Register (202, no session) then login (200, session). Returns the login
 *  response's cookies. The post-hardening flow: register no longer auto-logs-in. */
async function regThenLogin(email: string, password = "password123") {
  await SELF.fetch(jsonReq("/auth/register", "POST", { email, password }));
  const login = await SELF.fetch(jsonReq("/auth/login", "POST", { email, password }));
  return {
    login,
    session: getSetCookie(login, "ha_session"),
    csrf: getSetCookie(login, "ha_csrf"),
  };
}

describe("register → login → me → logout", () => {
  it("registers a new user with a uniform 202 accepted shape and does NOT auto-login", async () => {
    const res = await SELF.fetch(jsonReq("/auth/register", "POST", { email: "a@example.com", password: "password123" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    // No session is granted on register (anti-takeover + anti-enumeration): the
    // body must not carry a user/csrfToken and no session cookie is set.
    expect(body.user).toBeUndefined();
    expect(body.csrfToken).toBeUndefined();
    expect(body.ok).toBe(true);
    expect(getSetCookie(res, "ha_session")).toBeNull();
    // …but login right after works and DOES set an HttpOnly SameSite=Lax session.
    const login = await SELF.fetch(jsonReq("/auth/login", "POST", { email: "a@example.com", password: "password123" }));
    expect(login.status).toBe(200);
    expect(getSetCookie(login, "ha_session")).toBeTruthy();
    const rawSetCookie = setCookies(login).join("\n");
    expect(rawSetCookie).toMatch(/ha_session=[^;]+;[^]*HttpOnly/i);
    expect(rawSetCookie).toMatch(/SameSite=Lax/i);
  });

  it("logs in with correct credentials and rejects a wrong password", async () => {
    await SELF.fetch(jsonReq("/auth/register", "POST", { email: "u@example.com", password: "correctpass1" }));

    const wrong = await SELF.fetch(jsonReq("/auth/login", "POST", { email: "u@example.com", password: "WRONGpass1" }));
    expect(wrong.status).toBe(401);
    const wrongBody = (await wrong.json()) as any;
    // generic message — must not say "no such user" vs "wrong password"
    expect(wrongBody.error).toBe("auth_failed");

    const ok = await SELF.fetch(jsonReq("/auth/login", "POST", { email: "u@example.com", password: "correctpass1" }));
    expect(ok.status).toBe(200);
  });

  it("login for a non-existent email returns the SAME generic error as a wrong password", async () => {
    const res = await SELF.fetch(jsonReq("/auth/login", "POST", { email: "ghost@example.com", password: "whatever12" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe("auth_failed");
  });

  it("login for an ABSENT user still pays the PBKDF2 cost (finding #3 — no enumeration via timing)", async () => {
    // Register a real account so we have a "wrong password against an EXISTING
    // user" baseline (one full KDF). An ABSENT-user login must take a comparable
    // amount of work (the dummy KDF), not the ~0ms early-return.
    await SELF.fetch(jsonReq("/auth/register", "POST", { email: "exists@example.com", password: "password123" }));

    const wrongPwT0 = performance.now();
    const wrongPw = await SELF.fetch(jsonReq("/auth/login", "POST", { email: "exists@example.com", password: "totally-wrong" }));
    const wrongPwMs = performance.now() - wrongPwT0;
    expect(wrongPw.status).toBe(401);

    const absentT0 = performance.now();
    const absent = await SELF.fetch(jsonReq("/auth/login", "POST", { email: "nobody-here@example.com", password: "totally-wrong" }));
    const absentMs = performance.now() - absentT0;
    expect(absent.status).toBe(401);

    // Same generic error shape for both (no oracle on the body).
    expect(((await wrongPw.json()) as any).error).toBe("auth_failed");
    expect(((await absent.json()) as any).error).toBe("auth_failed");

    // The absent-user path must be in the SAME order of work as the real verify —
    // i.e. it ran a KDF, not the cheap early-return. Loose lower bound to avoid
    // flakiness on a busy CI runner; the point is "not ~0".
    expect(absentMs).toBeGreaterThan(wrongPwMs * 0.3);
  });

  it("/auth/me returns the user when authenticated, 401 otherwise", async () => {
    const { session, csrf } = await regThenLogin("me@example.com");

    const me = await SELF.fetch(jsonReq("/auth/me", "GET", undefined, { cookie: cookieHeader(session, csrf) }));
    expect(me.status).toBe(200);
    const body = (await me.json()) as any;
    expect(body.user.email).toBe("me@example.com");
    expect(body.user.hasPassword).toBe(true);
    expect(body.user.hasGoogle).toBe(false);

    const anon = await SELF.fetch(jsonReq("/auth/me", "GET"));
    expect(anon.status).toBe(401);
  });

  it("logout revokes the session (subsequent /me is 401)", async () => {
    const { session, csrf } = await regThenLogin("out@example.com");

    const out = await SELF.fetch(
      jsonReq("/auth/logout", "POST", undefined, { cookie: cookieHeader(session, csrf), "x-csrf-token": csrf! }),
    );
    expect(out.status).toBe(200);

    const me = await SELF.fetch(jsonReq("/auth/me", "GET", undefined, { cookie: cookieHeader(session, csrf) }));
    expect(me.status).toBe(401);
  });

  it("a wrong password does not invalidate an existing valid session", async () => {
    const { session, csrf } = await regThenLogin("persist@example.com");
    await SELF.fetch(jsonReq("/auth/login", "POST", { email: "persist@example.com", password: "nope" }));
    const me = await SELF.fetch(jsonReq("/auth/me", "GET", undefined, { cookie: cookieHeader(session, csrf) }));
    expect(me.status).toBe(200);
  });

  // ---- logout-after-reload (CSRF token survives /auth/me) -------------------
  // The SPA only keeps the csrf token in memory; a page reload restores the
  // authed state via /auth/me. /auth/me must therefore RE-SURFACE the session's
  // csrf token so logout can still send X-CSRF-Token — otherwise logout is
  // silently CSRF-rejected, the cookie is never revoked, and the reload would
  // re-authenticate (logout-bypass on a shared device).
  it("/auth/me returns the session csrfToken, and that exact token authorizes logout", async () => {
    const { session, csrf } = await regThenLogin("reload@example.com");

    // 1) /auth/me re-surfaces a csrf token …
    const me = await SELF.fetch(jsonReq("/auth/me", "GET", undefined, { cookie: cookieHeader(session, csrf) }));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as any;
    expect(typeof meBody.csrfToken).toBe("string");
    expect(meBody.csrfToken.length).toBeGreaterThan(0);
    // … and it is the SAME token logout requires (the login-time csrf cookie).
    expect(meBody.csrfToken).toBe(csrf);

    // 2) Simulate a reload where the SPA ONLY has the me-supplied token (no
    //    in-memory token from a login that never happened this page-load).
    //    Logout WITH that token → 200 and actually revokes the session.
    const out = await SELF.fetch(
      jsonReq("/auth/logout", "POST", undefined, {
        cookie: cookieHeader(session, csrf),
        "x-csrf-token": meBody.csrfToken,
      }),
    );
    expect(out.status).toBe(200);

    // 3) The session is gone server-side: /auth/me is now 401 (true logout).
    const after = await SELF.fetch(jsonReq("/auth/me", "GET", undefined, { cookie: cookieHeader(session, csrf) }));
    expect(after.status).toBe(401);
  });

  it("logout WITHOUT the csrf header is rejected (403) — the token is what makes it work", async () => {
    // The negative half of the invariant: the me-supplied token is load-bearing.
    // A reload that LOST the token (the original bug) would send no header here
    // → 403 → the session would survive (the bug we are fixing).
    const { session, csrf } = await regThenLogin("noreload@example.com");

    const out = await SELF.fetch(
      jsonReq("/auth/logout", "POST", undefined, { cookie: cookieHeader(session, csrf) }), // no x-csrf-token
    );
    expect(out.status).toBe(403);
    expect(((await out.json()) as any).error).toBe("csrf_failed");

    // Proof the session was NOT revoked (this is exactly the logout-bypass).
    const still = await SELF.fetch(jsonReq("/auth/me", "GET", undefined, { cookie: cookieHeader(session, csrf) }));
    expect(still.status).toBe(200);
  });
});

describe("register email enumeration (finding #4)", () => {
  it("an ALREADY-TAKEN email returns the IDENTICAL status + body as a NEW email", async () => {
    // First registration of a fresh email.
    const fresh = await SELF.fetch(jsonReq("/auth/register", "POST", { email: "enum@example.com", password: "password123" }));
    const freshBody = await fresh.json();

    // Re-register the SAME email (now taken).
    const dup = await SELF.fetch(jsonReq("/auth/register", "POST", { email: "enum@example.com", password: "different456" }));
    const dupBody = await dup.json();

    // No oracle: identical status code …
    expect(dup.status).toBe(fresh.status);
    expect(fresh.status).toBe(202);
    // … and identical response body (byte-for-byte).
    expect(dupBody).toEqual(freshBody);
    // … and neither sets a session cookie (no auto-login → no cookie-presence oracle).
    expect(getSetCookie(fresh, "ha_session")).toBeNull();
    expect(getSetCookie(dup, "ha_session")).toBeNull();
    // The message must not confirm the email is registered.
    expect((dupBody as any).message ?? "").not.toMatch(/登録済|already|exists|taken/i);

    // Sanity: the original account still has its ORIGINAL password (the dup
    // registration did NOT overwrite it — login with the first password works).
    const login = await SELF.fetch(jsonReq("/auth/login", "POST", { email: "enum@example.com", password: "password123" }));
    expect(login.status).toBe(200);
  });
});

describe("input validation", () => {
  it("rejects a malformed email", async () => {
    const res = await SELF.fetch(jsonReq("/auth/register", "POST", { email: "not-an-email", password: "password123" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_email");
  });

  it("rejects a too-short password", async () => {
    const res = await SELF.fetch(jsonReq("/auth/register", "POST", { email: "short@example.com", password: "abc" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_password");
  });
});

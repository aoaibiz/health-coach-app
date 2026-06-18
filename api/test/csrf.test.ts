import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { registerAndLogin } from "./helpers";

const ORIGIN = "http://localhost:3000";
const EVIL = "https://evil.example.com";

// Register (202, no session) then login (200, session) — the post-hardening flow.
async function auth(email: string) {
  return registerAndLogin(SELF, email);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM sessions");
  await env.DB.exec("DELETE FROM user_data");
  await env.DB.exec("DELETE FROM rate_limit");
});

describe("CSRF protection on state-changing requests", () => {
  it("PUT with a valid CSRF token + matching origin succeeds", async () => {
    const { cookie, csrf } = await auth("csrf1@example.com");
    const res = await SELF.fetch(
      new Request("https://api.test/api/user/data?section=profile", {
        method: "PUT",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ data: { ok: true } }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("PUT WITHOUT the CSRF header is rejected (403) even with a valid session", async () => {
    const { cookie } = await auth("csrf2@example.com");
    const res = await SELF.fetch(
      new Request("https://api.test/api/user/data?section=profile", {
        method: "PUT",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie }, // no x-csrf-token
        body: JSON.stringify({ data: { ok: true } }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("csrf_failed");
  });

  it("PUT with a WRONG CSRF token is rejected (403)", async () => {
    const { cookie } = await auth("csrf3@example.com");
    const res = await SELF.fetch(
      new Request("https://api.test/api/user/data?section=profile", {
        method: "PUT",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie, "x-csrf-token": "not-the-token" },
        body: JSON.stringify({ data: { ok: true } }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("PUT from a cross-site Origin is rejected (403) even with the right token", async () => {
    const { cookie, csrf } = await auth("csrf4@example.com");
    const res = await SELF.fetch(
      new Request("https://api.test/api/user/data?section=profile", {
        method: "PUT",
        headers: { origin: EVIL, "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ data: { ok: true } }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("does NOT echo CORS headers for a disallowed origin", async () => {
    const res = await SELF.fetch(
      new Request("https://api.test/auth/me", {
        method: "GET",
        headers: { origin: EVIL },
      }),
    );
    // No access-control-allow-origin for an origin that isn't APP_ORIGIN.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes CORS (with credentials) only for the exact app origin", async () => {
    const res = await SELF.fetch(
      new Request("https://api.test/auth/me", {
        method: "OPTIONS",
        headers: { origin: ORIGIN },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

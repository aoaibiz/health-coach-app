import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { getCookie } from "./helpers";

// Finding #2 (HIGH) — login-CSRF / cross-site register defense. The PRE-session
// auth endpoints (/auth/register, /auth/login) are state-changing and have no
// CSRF token yet, so the strict, FAIL-CLOSED Origin/Referer check IS the gate.
// An attacker must not be able to silently log the victim into the attacker's
// account (login-CSRF) nor register cross-site.

const APP_ORIGIN = "http://localhost:3000"; // wrangler.toml [vars] APP_ORIGIN
const EVIL = "https://evil.example.com";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM sessions");
  await env.DB.exec("DELETE FROM rate_limit");
});

describe("Origin gate on pre-session auth endpoints (anti login-CSRF)", () => {
  it("rejects /auth/login from a CROSS-SITE Origin (403, no session)", async () => {
    // Seed a real account so this can't pass for the wrong reason.
    await SELF.fetch(post("/auth/login", { email: "x@example.com", password: "password123" }, { origin: APP_ORIGIN }));
    const res = await SELF.fetch(post("/auth/login", { email: "x@example.com", password: "password123" }, { origin: EVIL }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("origin_not_allowed");
    expect(getCookie(res, "ha_session")).toBeNull();
  });

  it("rejects /auth/register from a CROSS-SITE Origin (403)", async () => {
    const res = await SELF.fetch(post("/auth/register", { email: "new@example.com", password: "password123" }, { origin: EVIL }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("origin_not_allowed");
    // Nothing was created.
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>();
    expect(row!.c).toBe(0);
  });

  it("rejects /auth/login when Origin AND Referer are BOTH ABSENT (fail-closed)", async () => {
    // A forged top-level navigation / form post can omit Origin; we must reject,
    // not default-allow. No origin, no referer header at all.
    const res = await SELF.fetch(post("/auth/login", { email: "x@example.com", password: "password123" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe("origin_not_allowed");
  });

  it("rejects /auth/register with a CROSS-SITE Referer when Origin is absent", async () => {
    const res = await SELF.fetch(
      post("/auth/register", { email: "ref@example.com", password: "password123" }, { referer: `${EVIL}/page` }),
    );
    expect(res.status).toBe(403);
  });

  it("ALLOWS /auth/register + /auth/login from the exact APP origin", async () => {
    const reg = await SELF.fetch(post("/auth/register", { email: "ok@example.com", password: "password123" }, { origin: APP_ORIGIN }));
    expect(reg.status).toBe(202); // accepted
    const login = await SELF.fetch(post("/auth/login", { email: "ok@example.com", password: "password123" }, { origin: APP_ORIGIN }));
    expect(login.status).toBe(200);
    expect(getCookie(login, "ha_session")).toBeTruthy();
  });

  it("ALLOWS /auth/login via a same-origin Referer when Origin is omitted", async () => {
    await SELF.fetch(post("/auth/register", { email: "refok@example.com", password: "password123" }, { origin: APP_ORIGIN }));
    const login = await SELF.fetch(
      post("/auth/login", { email: "refok@example.com", password: "password123" }, { referer: `${APP_ORIGIN}/login` }),
    );
    expect(login.status).toBe(200);
  });
});

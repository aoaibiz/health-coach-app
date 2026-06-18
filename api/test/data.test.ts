import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { registerAndLogin } from "./helpers";

const ORIGIN = "http://localhost:3000";

function req(path: string, method: string, opts: { body?: unknown; cookie?: string; csrf?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers["x-csrf-token"] = opts.csrf;
  return new Request(`https://api.test${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

// Register (202, no session) then login (200, session) — the post-hardening flow.
async function registerAndAuth(email: string) {
  return registerAndLogin(SELF, email);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM sessions");
  await env.DB.exec("DELETE FROM user_data");
  await env.DB.exec("DELETE FROM rate_limit");
});

describe("authenticated data API", () => {
  it("requires a valid session (401 without)", async () => {
    const res = await SELF.fetch(req("/api/user/data?section=profile", "GET"));
    expect(res.status).toBe(401);
  });

  it("GET returns null for a section with no data yet", async () => {
    const { cookie } = await registerAndAuth("d1@example.com");
    const res = await SELF.fetch(req("/api/user/data?section=profile", "GET", { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeNull();
  });

  it("PUT then GET round-trips the user's data", async () => {
    const { cookie, csrf } = await registerAndAuth("d2@example.com");
    const payload = { name: "Ao", goal: "減量", weightKg: 70 };
    const put = await SELF.fetch(req("/api/user/data?section=profile", "PUT", { cookie, csrf, body: { data: payload } }));
    expect(put.status).toBe(200);

    const get = await SELF.fetch(req("/api/user/data?section=profile", "GET", { cookie }));
    const body = (await get.json()) as any;
    expect(body.data).toEqual(payload);
    expect(typeof body.updatedAt).toBe("number");
  });

  it("rejects an unknown section", async () => {
    const { cookie } = await registerAndAuth("d3@example.com");
    const res = await SELF.fetch(req("/api/user/data?section=evil", "GET", { cookie }));
    expect(res.status).toBe(400);
  });

  it("isolates data per user (user B cannot read user A's data)", async () => {
    const a = await registerAndAuth("usera@example.com");
    await SELF.fetch(req("/api/user/data?section=meals", "PUT", { cookie: a.cookie, csrf: a.csrf, body: { data: [{ secret: "A" }] } }));

    const b = await registerAndAuth("userb@example.com");
    const res = await SELF.fetch(req("/api/user/data?section=meals", "GET", { cookie: b.cookie }));
    const body = (await res.json()) as any;
    // B sees its OWN (empty) data, never A's.
    expect(body.data).toBeNull();
  });
});

describe("SQL injection / parameterization", () => {
  it("a SQLi-style email is treated as a literal (no users dropped, no auth bypass)", async () => {
    const { cookie } = await registerAndAuth("victim@example.com");
    // Attempt classic injection payloads via email + section. They must be
    // handled as plain data (parameterized queries) — never executed as SQL.
    const inj = `'; DROP TABLE users;--@x.com`;
    const r1 = await SELF.fetch(req("/auth/login", "POST", { body: { email: inj, password: "x" } }));
    // Either rejected as invalid email (400) or generic auth fail (401) — but
    // crucially the users table must survive.
    expect([400, 401, 429]).toContain(r1.status);

    // Confirm the table + the existing user still exist (DROP did not run).
    const me = await SELF.fetch(req("/auth/me", "GET", { cookie }));
    expect(me.status).toBe(200);
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>();
    expect(count!.c).toBe(1);
  });

  it("stores injection-y payload data verbatim (bound param, not executed)", async () => {
    const { cookie, csrf } = await registerAndAuth("payload@example.com");
    const evil = { note: `Robert'); DROP TABLE user_data;--` };
    await SELF.fetch(req("/api/user/data?section=profile", "PUT", { cookie, csrf, body: { data: evil } }));
    const get = await SELF.fetch(req("/api/user/data?section=profile", "GET", { cookie }));
    const body = (await get.json()) as any;
    expect(body.data).toEqual(evil); // stored + returned literally
    // table still present
    const ok = await env.DB.prepare("SELECT COUNT(*) AS c FROM user_data").first<{ c: number }>();
    expect(ok!.c).toBe(1);
  });
});

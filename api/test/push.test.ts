import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { registerAndLogin } from "./helpers";

// Route-level tests for the Web Push API. They prove the SAME auth + CSRF gate as
// the data API protects subscribe/unsubscribe/test, that public-key is public,
// and that subscriptions are isolated per user. They do NOT send a real push
// (that needs a live browser endpoint — see webpush.test.ts note); /api/push/test
// against an unreachable fake endpoint is covered by asserting it never 500s and
// reports a JSON {sent, gone} shape.

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

// Valid-shape keys: p256dh decodes to a 65-byte uncompressed P-256 point
// (first byte 0x04), auth to 16 bytes — what the subscribe validator now enforces.
const VALID_P256DH = "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A";
const VALID_AUTH = "AQIDBAUGBwgJCgsMDQ4PEA";

const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/fake-endpoint-aaa",
  keys: { p256dh: VALID_P256DH, auth: VALID_AUTH },
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users");
  await env.DB.exec("DELETE FROM sessions");
  await env.DB.exec("DELETE FROM push_subscriptions");
  await env.DB.exec("DELETE FROM rate_limit");
});

describe("GET /api/push/public-key (public)", () => {
  it("returns the VAPID public key without any auth", async () => {
    const res = await SELF.fetch(req("/api/push/public-key", "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publicKey: string };
    expect(typeof body.publicKey).toBe("string");
    expect(body.publicKey.length).toBeGreaterThan(0);
    // base64url charset (it's the browser's applicationServerKey)
    expect(body.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("push subscribe/unsubscribe auth + CSRF gate", () => {
  it("subscribe requires a session (401 without)", async () => {
    const res = await SELF.fetch(req("/api/push/subscribe", "POST", { body: SUB }));
    expect(res.status).toBe(401);
  });

  it("subscribe requires the CSRF token (403 with session but no token)", async () => {
    const { cookie } = await registerAndLogin(SELF, "p1@example.com");
    const res = await SELF.fetch(req("/api/push/subscribe", "POST", { cookie, body: SUB }));
    expect(res.status).toBe(403);
  });

  it("subscribe with a valid session + CSRF stores the subscription", async () => {
    const { cookie, csrf, userId } = await registerAndLogin(SELF, "p2@example.com");
    const res = await SELF.fetch(req("/api/push/subscribe", "POST", { cookie, csrf, body: SUB }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true });

    const row = await env.DB.prepare("SELECT user_id, endpoint FROM push_subscriptions WHERE endpoint = ?1")
      .bind(SUB.endpoint)
      .first<{ user_id: string; endpoint: string }>();
    expect(row!.user_id).toBe(userId);
    expect(row!.endpoint).toBe(SUB.endpoint);
  });

  it("re-subscribing the same endpoint UPSERTs (no duplicate row)", async () => {
    const { cookie, csrf } = await registerAndLogin(SELF, "p3@example.com");
    await SELF.fetch(req("/api/push/subscribe", "POST", { cookie, csrf, body: SUB }));
    await SELF.fetch(req("/api/push/subscribe", "POST", { cookie, csrf, body: SUB }));
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM push_subscriptions").first<{ c: number }>();
    expect(count!.c).toBe(1);
  });

  it("rejects a malformed subscription (400)", async () => {
    const { cookie, csrf } = await registerAndLogin(SELF, "p4@example.com");
    // non-https endpoint
    const bad = await SELF.fetch(
      req("/api/push/subscribe", "POST", { cookie, csrf, body: { endpoint: "http://evil/x", keys: SUB.keys } }),
    );
    expect(bad.status).toBe(400);
    // missing keys
    const bad2 = await SELF.fetch(
      req("/api/push/subscribe", "POST", { cookie, csrf, body: { endpoint: SUB.endpoint } }),
    );
    expect(bad2.status).toBe(400);
    // https but NOT a known push service (SSRF-style endpoint)
    const bad3 = await SELF.fetch(
      req("/api/push/subscribe", "POST", { cookie, csrf, body: { endpoint: "https://evil.example.com/x", keys: SUB.keys } }),
    );
    expect(bad3.status).toBe(400);
    // wrong-size keys (p256dh not 65 bytes)
    const bad4 = await SELF.fetch(
      req("/api/push/subscribe", "POST", {
        cookie,
        csrf,
        body: { endpoint: SUB.endpoint, keys: { p256dh: "BPtooShort", auth: VALID_AUTH } },
      }),
    );
    expect(bad4.status).toBe(400);
  });

  it("does NOT reassign an endpoint owned by a DIFFERENT user (409 endpoint_conflict)", async () => {
    const a = await registerAndLogin(SELF, "ownerA@example.com");
    const aRes = await SELF.fetch(req("/api/push/subscribe", "POST", { cookie: a.cookie, csrf: a.csrf, body: SUB }));
    expect(aRes.status).toBe(200);

    // A second user tries to register the SAME endpoint → rejected, row untouched.
    const b = await registerAndLogin(SELF, "userB@example.com");
    const bRes = await SELF.fetch(req("/api/push/subscribe", "POST", { cookie: b.cookie, csrf: b.csrf, body: SUB }));
    expect(bRes.status).toBe(409);

    const row = await env.DB.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?1")
      .bind(SUB.endpoint)
      .first<{ user_id: string }>();
    expect(row!.user_id).toBe(a.userId); // still A's, never reassigned to B
  });

  it("unsubscribe deletes ONLY the calling user's row", async () => {
    const a = await registerAndLogin(SELF, "owner@example.com");
    await SELF.fetch(req("/api/push/subscribe", "POST", { cookie: a.cookie, csrf: a.csrf, body: SUB }));

    // A different user cannot delete A's endpoint (scoped by user_id): the row survives.
    const b = await registerAndLogin(SELF, "other@example.com");
    const bDel = await SELF.fetch(
      req("/api/push/unsubscribe", "POST", { cookie: b.cookie, csrf: b.csrf, body: { endpoint: SUB.endpoint } }),
    );
    expect(bDel.status).toBe(200); // idempotent ok
    const stillThere = await env.DB.prepare("SELECT COUNT(*) AS c FROM push_subscriptions").first<{ c: number }>();
    expect(stillThere!.c).toBe(1);

    // The owner CAN delete it.
    const aDel = await SELF.fetch(
      req("/api/push/unsubscribe", "POST", { cookie: a.cookie, csrf: a.csrf, body: { endpoint: SUB.endpoint } }),
    );
    expect(aDel.status).toBe(200);
    const gone = await env.DB.prepare("SELECT COUNT(*) AS c FROM push_subscriptions").first<{ c: number }>();
    expect(gone!.c).toBe(0);
  });
});

describe("POST /api/push/test", () => {
  it("requires a session + CSRF", async () => {
    expect((await SELF.fetch(req("/api/push/test", "POST"))).status).toBe(401);
    const { cookie } = await registerAndLogin(SELF, "t1@example.com");
    expect((await SELF.fetch(req("/api/push/test", "POST", { cookie }))).status).toBe(403);
  });

  it("returns {sent,gone} JSON and never 500s even with no subscriptions", async () => {
    const { cookie, csrf } = await registerAndLogin(SELF, "t2@example.com");
    const res = await SELF.fetch(req("/api/push/test", "POST", { cookie, csrf }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number; gone: number };
    expect(body).toEqual({ sent: 0, gone: 0 });
  });
});

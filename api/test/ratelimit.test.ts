import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { consume, reset, clientIp, LOGIN_EMAIL_RULE } from "../src/lib/ratelimit";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM rate_limit");
});

describe("rate limiter (D1 fixed-window + lockout)", () => {
  it("allows up to `max` attempts then blocks with a retry-after", async () => {
    const rule = { max: 3, windowSec: 600, lockoutSec: 300 };
    const bucket = "login:email:test@example.com";

    for (let i = 0; i < 3; i++) {
      const r = await consume(env, bucket, rule);
      expect(r.allowed).toBe(true);
    }
    const blocked = await consume(env, bucket, rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);

    // Stays blocked on the next attempt too.
    const stillBlocked = await consume(env, bucket, rule);
    expect(stillBlocked.allowed).toBe(false);
  });

  it("reset() clears the bucket (successful-login path)", async () => {
    const rule = { max: 2, windowSec: 600, lockoutSec: 300 };
    const bucket = "login:email:reset@example.com";
    await consume(env, bucket, rule);
    await consume(env, bucket, rule);
    expect((await consume(env, bucket, rule)).allowed).toBe(false);
    await reset(env, bucket);
    expect((await consume(env, bucket, rule)).allowed).toBe(true);
  });

  it("the real LOGIN_EMAIL_RULE blocks after its configured max", async () => {
    const bucket = "login:email:real@example.com";
    let lastAllowed = true;
    for (let i = 0; i < LOGIN_EMAIL_RULE.max + 1; i++) {
      lastAllowed = (await consume(env, bucket, LOGIN_EMAIL_RULE)).allowed;
    }
    expect(lastAllowed).toBe(false);
  });

  it("separate buckets are independent (per-email isolation)", async () => {
    const rule = { max: 1, windowSec: 600, lockoutSec: 300 };
    expect((await consume(env, "login:email:x@a.com", rule)).allowed).toBe(true);
    // x is now exhausted but y is fresh
    expect((await consume(env, "login:email:x@a.com", rule)).allowed).toBe(false);
    expect((await consume(env, "login:email:y@a.com", rule)).allowed).toBe(true);
  });
});

describe("clientIp trusts ONLY cf-connecting-ip (finding #5)", () => {
  const mk = (headers: Record<string, string>) => new Request("https://api.test/", { headers });

  it("uses cf-connecting-ip when present", () => {
    expect(clientIp(mk({ "cf-connecting-ip": "203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("IGNORES a client-supplied x-real-ip (no spoofable fallback)", () => {
    // An attacker forging x-real-ip per request must NOT get a fresh bucket: with
    // no trusted cf-connecting-ip, everyone shares the "unknown" bucket.
    expect(clientIp(mk({ "x-real-ip": "1.2.3.4" }))).toBe("unknown");
    expect(clientIp(mk({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "8.8.8.8" }))).toBe("unknown");
    // …and when cf-connecting-ip IS present, x-real-ip can't override it.
    expect(clientIp(mk({ "cf-connecting-ip": "198.51.100.1", "x-real-ip": "1.2.3.4" }))).toBe("198.51.100.1");
  });

  it("falls back to the shared 'unknown' bucket when no trusted header is set", () => {
    expect(clientIp(mk({}))).toBe("unknown");
  });
});

describe("rate limiter via the login endpoint", () => {
  it("eventually returns 429 on repeated failed logins for one email", async () => {
    const { SELF } = await import("cloudflare:test");
    const ORIGIN = "http://localhost:3000";
    await env.DB.exec("DELETE FROM users");
    await env.DB.exec("DELETE FROM rate_limit");

    let saw429 = false;
    for (let i = 0; i < LOGIN_EMAIL_RULE.max + 2; i++) {
      const res = await SELF.fetch(
        new Request("https://api.test/auth/login", {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email: "brute@example.com", password: "wrong-guess" }),
        }),
      );
      if (res.status === 429) {
        saw429 = true;
        expect(res.headers.get("retry-after")).toBeTruthy();
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});

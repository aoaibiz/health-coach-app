import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { cookieSecure, configError, isProduction } from "../src/lib/env";
import { serializeCookie } from "../src/lib/http";
import type { Env } from "../src/lib/env";

// Finding #7 (MED) — the Secure cookie attribute must be FAIL-CLOSED in
// production: prod always sets Secure regardless of COOKIE_SECURE, and a prod
// deploy with COOKIE_SECURE != "true" is rejected as a misconfiguration (so a
// typo can never ship session/CSRF cookies over plaintext).

const base = env as unknown as Env;
const prod = (cookieSecure: string): Env => ({ ...base, ENVIRONMENT: "production", COOKIE_SECURE: cookieSecure });
const dev = (cookieSecure: string): Env => ({ ...base, ENVIRONMENT: "development", COOKIE_SECURE: cookieSecure });

describe("cookieSecure / configError fail-closed in production (finding #7)", () => {
  it("production forces Secure EVEN WHEN COOKIE_SECURE=false", () => {
    expect(isProduction(prod("false"))).toBe(true);
    expect(cookieSecure(prod("false"))).toBe(true); // forced on despite the flag
    expect(cookieSecure(prod("true"))).toBe(true);
  });

  it("a production deploy with COOKIE_SECURE != 'true' is a CONFIG ERROR", () => {
    expect(configError(prod("false"))).toBe("insecure_cookie_config_in_production");
    expect(configError(prod(""))).toBe("insecure_cookie_config_in_production");
    expect(configError(prod("true"))).toBeNull(); // correctly configured prod
  });

  it("outside production, Secure follows COOKIE_SECURE (so http://localhost dev keeps the cookie)", () => {
    expect(cookieSecure(dev("false"))).toBe(false);
    expect(cookieSecure(dev("true"))).toBe(true);
    expect(configError(dev("false"))).toBeNull(); // dev with insecure cookies is fine
  });

  it("the serialized cookie carries `Secure` in production regardless of the flag", () => {
    const c = serializeCookie("ha_session", "abc", prod("false"), { httpOnly: true });
    expect(c).toMatch(/;\s*Secure/);
    // and in dev with COOKIE_SECURE=false it must NOT (so the cookie sticks on http).
    const dc = serializeCookie("ha_session", "abc", dev("false"), { httpOnly: true });
    expect(dc).not.toMatch(/;\s*Secure/);
  });
});

describe("the entrypoint rejects an insecure production config (finding #7, fail-closed)", () => {
  it("returns 500 server_error when ENVIRONMENT=production but COOKIE_SECURE=false", async () => {
    // Drive the real Worker fetch handler with a prod-misconfig env clone.
    const worker = (await import("../src/index")).default;
    const res = await worker.fetch!(new Request("https://api.test/health", { method: "GET" }), prod("false") as any);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toBe("server_error");
  });

  it("serves normally when production is correctly configured (COOKIE_SECURE=true)", async () => {
    const worker = (await import("../src/index")).default;
    const res = await worker.fetch!(new Request("https://api.test/health", { method: "GET" }), prod("true") as any);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
  });
});

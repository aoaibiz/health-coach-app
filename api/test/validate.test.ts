import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  validatePassword,
  validateDataPayload,
  safeRelativePath,
  isDataSection,
  cleanDisplayName,
  isAllowedPushEndpoint,
  validatePushSubscription,
  MAX_DATA_BLOB_BYTES,
} from "../src/lib/validate";

// base64url-encode helper for building valid/invalid push-key fixtures.
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function p256dhOf(len: number, firstByte = 0x04): string {
  const b = new Uint8Array(len);
  b[0] = firstByte;
  return b64url(b);
}
const VALID_ENDPOINT = "https://fcm.googleapis.com/fcm/send/x";

describe("normalizeEmail", () => {
  it("lowercases + trims valid addresses", () => {
    expect(normalizeEmail("  A@Example.COM ")).toBe("a@example.com");
  });
  it("rejects malformed / injection-y values", () => {
    for (const bad of ["", "no-at", "a@b", "a b@c.com", `a"@c.com`, "a@<x>.com", null, 42]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe("validatePassword", () => {
  it("enforces min/max length, no composition rules", () => {
    expect(validatePassword("abc").ok).toBe(false);
    expect(validatePassword("12345678").ok).toBe(true);
    expect(validatePassword("x".repeat(200)).ok).toBe(false);
  });
});

describe("validateDataPayload", () => {
  it("accepts objects/arrays and returns canonical JSON", () => {
    const r = validateDataPayload({ a: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.json).toBe('{"a":1}');
  });
  it("rejects non-objects + oversized blobs", () => {
    expect(validateDataPayload("string").ok).toBe(false);
    expect(validateDataPayload(123).ok).toBe(false);
    const huge = { x: "a".repeat(MAX_DATA_BLOB_BYTES + 10) };
    expect(validateDataPayload(huge).ok).toBe(false);
  });
});

describe("safeRelativePath (open-redirect defense)", () => {
  it("allows safe relative paths", () => {
    expect(safeRelativePath("/")).toBe("/");
    expect(safeRelativePath("/chat")).toBe("/chat");
  });
  it("rejects absolute + protocol-relative + control-char paths", () => {
    expect(safeRelativePath("https://evil.com")).toBeNull();
    expect(safeRelativePath("//evil.com")).toBeNull();
    expect(safeRelativePath("/ok\nthen")).toBeNull();
    expect(safeRelativePath("chat")).toBeNull();
  });
});

describe("isDataSection + cleanDisplayName", () => {
  it("only known sections pass", () => {
    expect(isDataSection("profile")).toBe(true);
    expect(isDataSection("meals")).toBe(true);
    expect(isDataSection("workouts")).toBe(true);
    expect(isDataSection("../etc")).toBe(false);
    expect(isDataSection(123)).toBe(false);
  });
  it("display name is single-lined + bounded", () => {
    expect(cleanDisplayName("Ao\nさん")).toBe("Aoさん");
    expect(cleanDisplayName("   ")).toBeNull();
    expect((cleanDisplayName("x".repeat(100)) ?? "").length).toBeLessThanOrEqual(60);
  });
});

describe("isAllowedPushEndpoint (push-service allow-list)", () => {
  it("accepts the real browser push services", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true); // Chrome/Android
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true); // Firefox
    expect(isAllowedPushEndpoint("https://abc.notify.windows.com/w/?token=x")).toBe(true); // Edge/WNS
    expect(isAllowedPushEndpoint("https://web.push.apple.com/xyz")).toBe(true); // Safari/APNs
  });
  it("rejects arbitrary hosts, non-https, and look-alike sub-domains", () => {
    expect(isAllowedPushEndpoint("https://evil.example.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false); // not https
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.com/x")).toBe(false); // suffix look-alike
    expect(isAllowedPushEndpoint("https://notfcm.googleapis.com/x")).toBe(false); // exact-host only
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
  });
});

describe("validatePushSubscription key-size checks", () => {
  const validAuth = b64url(new Uint8Array(16).fill(7));
  const validP256dh = p256dhOf(65);

  it("accepts valid sizes (65-byte 0x04 p256dh, 16-byte auth)", () => {
    const r = validatePushSubscription({ endpoint: VALID_ENDPOINT, keys: { p256dh: validP256dh, auth: validAuth } });
    expect(r.ok).toBe(true);
  });
  it("rejects a 64-byte p256dh", () => {
    const r = validatePushSubscription({ endpoint: VALID_ENDPOINT, keys: { p256dh: p256dhOf(64), auth: validAuth } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_push_keys");
  });
  it("rejects a non-0x04 prefix on a 65-byte p256dh", () => {
    const r = validatePushSubscription({
      endpoint: VALID_ENDPOINT,
      keys: { p256dh: p256dhOf(65, 0x03), auth: validAuth },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_push_keys");
  });
  it("rejects a 15-byte auth", () => {
    const r = validatePushSubscription({
      endpoint: VALID_ENDPOINT,
      keys: { p256dh: validP256dh, auth: b64url(new Uint8Array(15).fill(7)) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_push_keys");
  });
  it("rejects an endpoint that is not a known push service", () => {
    const r = validatePushSubscription({
      endpoint: "https://evil.example.com/x",
      keys: { p256dh: validP256dh, auth: validAuth },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_push_endpoint");
  });
});

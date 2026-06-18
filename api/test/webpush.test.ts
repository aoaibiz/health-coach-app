import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  concatBytes,
  base64UrlEncode,
  base64UrlDecode,
  hkdf,
  buildKeyInfo,
  cekInfo,
  nonceInfo,
  vapidHeader,
  vapidClaims,
  encodeJwtSegment,
  jwtSigningInput,
  sendPush,
} from "../src/lib/webpush";

// These tests cover the PURE, deterministic helpers of the Web Push
// implementation: base64url round-trip, byte concat, the RFC 8291/8188 HKDF
// "info" string construction, HKDF determinism, and the VAPID JWT header/payload
// encoding (RFC 8292). They run in the real Workers runtime (Web Crypto), so
// they exercise crypto.subtle exactly as production does.
//
// NOTE: the FULL message-encryption + POST (sendPush) cannot be verified here —
// it requires a live browser push subscription (a real endpoint + the browser's
// per-session p256dh/auth keys). True delivery is an e2e step AFTER the frontend
// subscribes a real browser. See the report's honest-limitations note.

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("base64url round-trip", () => {
  it("encodes then decodes back to the same bytes (no padding, url-safe charset)", () => {
    for (const len of [0, 1, 2, 3, 16, 32, 65, 100]) {
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      const encd = base64UrlEncode(bytes);
      // url-safe charset only: never + / =
      expect(encd).toMatch(/^[A-Za-z0-9_-]*$/);
      const back = base64UrlDecode(encd);
      expect(Array.from(back)).toEqual(Array.from(bytes));
    }
  });

  it("decodes a known vector and tolerates missing padding", () => {
    // "hello" → base64 "aGVsbG8=" → base64url "aGVsbG8" (padding stripped)
    expect(dec.decode(base64UrlDecode("aGVsbG8"))).toBe("hello");
    expect(dec.decode(base64UrlDecode("aGVsbG8="))).toBe("hello");
  });

  it("decodes url-safe '-' and '_' as the base64 '+' and '/' bytes", () => {
    // 0xFB,0xFF,0xBF → standard base64 "+/+/" → base64url "-_-_" (4 chars, valid len)
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const url = base64UrlEncode(bytes); // "-_-_"
    expect(url).toBe("-_-_");
    expect(Array.from(base64UrlDecode(url))).toEqual(Array.from(bytes));
  });

  it("encodes a known byte vector to the expected base64url", () => {
    expect(base64UrlEncode(enc.encode("hello"))).toBe("aGVsbG8");
    expect(base64UrlEncode(new Uint8Array([255, 255, 255]))).toBe("____");
  });
});

describe("concatBytes", () => {
  it("concatenates in order, preserving every byte", () => {
    const out = concatBytes(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3, 4, 5]));
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });
  it("returns an empty array for no input", () => {
    expect(concatBytes().length).toBe(0);
  });
});

describe("RFC 8291 / 8188 info-string construction", () => {
  it('buildKeyInfo = "WebPush: info" || 0x00 || ua(65) || as(65), in that order', () => {
    const ua = new Uint8Array(65).fill(0xaa);
    const as = new Uint8Array(65).fill(0xbb);
    const info = buildKeyInfo(ua, as);

    const prefix = enc.encode("WebPush: info");
    expect(info.length).toBe(prefix.length + 1 + 65 + 65);
    // prefix
    expect(Array.from(info.slice(0, prefix.length))).toEqual(Array.from(prefix));
    // null separator
    expect(info[prefix.length]).toBe(0x00);
    // ua key FIRST (client), then as key (server) — order is load-bearing
    expect(info[prefix.length + 1]).toBe(0xaa);
    expect(info[prefix.length + 1 + 65]).toBe(0xbb);
  });

  it('cekInfo = "Content-Encoding: aes128gcm" || 0x00', () => {
    const info = cekInfo();
    const prefix = enc.encode("Content-Encoding: aes128gcm");
    expect(info.length).toBe(prefix.length + 1);
    expect(dec.decode(info.slice(0, prefix.length))).toBe("Content-Encoding: aes128gcm");
    expect(info[info.length - 1]).toBe(0x00);
  });

  it('nonceInfo = "Content-Encoding: nonce" || 0x00', () => {
    const info = nonceInfo();
    const prefix = enc.encode("Content-Encoding: nonce");
    expect(info.length).toBe(prefix.length + 1);
    expect(dec.decode(info.slice(0, prefix.length))).toBe("Content-Encoding: nonce");
    expect(info[info.length - 1]).toBe(0x00);
  });
});

describe("HKDF-SHA256 (RFC 5869)", () => {
  it("is deterministic and outputs the requested length", async () => {
    const salt = new Uint8Array(16).fill(1);
    const ikm = new Uint8Array(32).fill(2);
    const info = cekInfo();
    const a = await hkdf(salt, ikm, info, 16);
    const b = await hkdf(salt, ikm, info, 16);
    expect(a.length).toBe(16);
    expect(Array.from(a)).toEqual(Array.from(b)); // deterministic
    // Different info → different output (domain separation).
    const c = await hkdf(salt, ikm, nonceInfo(), 16);
    expect(Array.from(a)).not.toEqual(Array.from(c));
    // Different length is honoured.
    const n = await hkdf(salt, ikm, nonceInfo(), 12);
    expect(n.length).toBe(12);
  });

  it("matches the RFC 5869 Test Case 1 (SHA-256) expansion", async () => {
    // RFC 5869 Appendix A.1: IKM=0x0b*22, salt=0x00..0c, info=0xf0..f9, L=42.
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = new Uint8Array(Array.from({ length: 13 }, (_, i) => i)); // 00..0c
    const info = new Uint8Array([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
    const okm = await hkdf(salt, ikm, info, 42);
    const expected =
      "3cb25f25faacd57a90434f64d0362f2a" +
      "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
      "34007208d5b887185865";
    const hex = Array.from(okm).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(expected);
  });
});

describe("ECDH derive on this runtime (workerd field-name + correctness)", () => {
  it("two P-256 parties derive the SAME shared secret via the field webpush.ts uses", async () => {
    // RFC 8291 relies on a correct ECDH shared secret. The Cloudflare types name
    // the peer-key field `$public`; this test PROVES that field actually performs
    // a correct ECDH on the real workerd runtime (both parties agree) — so the
    // production sendPush path derives the right key, not silently-wrong bytes.
    const alice = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const bob = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;

    const a = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: bob.publicKey } as any, alice.privateKey, 256),
    );
    const b = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: alice.publicKey } as any, bob.privateKey, 256),
    );
    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b)); // ECDH agreement → field works
  });
});

describe("record-size guard", () => {
  it("throws (before any network) when the payload can't fit one 4096-byte record", async () => {
    // A payload whose JSON exceeds rs - 1 (delimiter) - 16 (GCM tag) must be
    // rejected up front. The guard fires at the top of encryptPayload, before the
    // JWT signing / fetch, so a dummy subscription is fine for this assertion.
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "x", auth: "y" };
    const huge = { body: "あ".repeat(5000) };
    await expect(sendPush(sub, huge, env)).rejects.toThrow(/too large/);
  });
});

describe("VAPID JWT (RFC 8292) header/payload encoding", () => {
  it("header is the fixed {typ:JWT,alg:ES256}", () => {
    expect(vapidHeader()).toEqual({ typ: "JWT", alg: "ES256" });
  });

  it("claims use the endpoint ORIGIN as aud (not the full path) + the subject", () => {
    const now = 1_700_000_000;
    const c = vapidClaims(
      "https://fcm.googleapis.com/fcm/send/abc123?x=1",
      "mailto:you@example.com",
      now,
    );
    expect(c.aud).toBe("https://fcm.googleapis.com"); // origin only
    expect(c.sub).toBe("mailto:you@example.com");
    expect(c.exp).toBe(now + 12 * 3600); // default 12h
  });

  it("caps exp at ≤ 24h in the future (RFC 8292 §2)", () => {
    const now = 1_700_000_000;
    const c = vapidClaims("https://push.example/x", "mailto:a@b.com", now, 48 * 3600);
    expect(c.exp).toBe(now + 24 * 3600); // capped, not 48h
  });

  it("encodeJwtSegment is base64url JSON; signing input is segment.segment", () => {
    const seg = encodeJwtSegment({ typ: "JWT", alg: "ES256" });
    expect(seg).toMatch(/^[A-Za-z0-9_-]+$/);
    // decodes back to the same JSON
    expect(JSON.parse(dec.decode(base64UrlDecode(seg)))).toEqual({ typ: "JWT", alg: "ES256" });

    const input = jwtSigningInput({ typ: "JWT", alg: "ES256" }, { aud: "https://x", exp: 1, sub: "mailto:a@b" });
    const [h, p] = input.split(".");
    expect(JSON.parse(dec.decode(base64UrlDecode(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(dec.decode(base64UrlDecode(p!)))).toEqual({ aud: "https://x", exp: 1, sub: "mailto:a@b" });
  });

  it("the signing input is ES256-verifiable end-to-end with a P-256 keypair", async () => {
    // Prove the JWT bytes we build are correctly signable/verifiable under ES256
    // (the same crypto.subtle path signVapidJwt uses), without needing a real
    // VAPID secret: generate a throwaway P-256 keypair here.
    const kp = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    const input = jwtSigningInput(vapidHeader(), vapidClaims("https://push.example/p", "mailto:a@b.com", 1_700_000_000));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, enc.encode(input));
    // ES256 raw signature is exactly 64 bytes (r||s).
    expect(new Uint8Array(sig).length).toBe(64);

    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, sig, enc.encode(input));
    expect(ok).toBe(true);

    // A tampered payload must NOT verify.
    const bad = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      kp.publicKey,
      sig,
      enc.encode(input + "x"),
    );
    expect(bad).toBe(false);
  });
});

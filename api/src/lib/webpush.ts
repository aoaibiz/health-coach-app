// Workers-native Web Push — sends an encrypted push message to a browser push
// service using ONLY Web Crypto (crypto.subtle). The Node `web-push` package is
// deliberately NOT used: it relies on Node crypto + Buffer and does not run on
// the Cloudflare Workers runtime. Everything here is built on the same
// crypto.subtle primitives the rest of the codebase uses (see lib/crypto.ts).
//
// RFCs implemented:
//   * RFC 8292 — VAPID: a self-signed ES256 JWT in the Authorization header
//     proves the application server's identity to the push service.
//   * RFC 8291 — Message Encryption for Web Push: ECDH (P-256) + HKDF-SHA256
//     derive the content-encryption key/nonce from the subscription keys.
//   * RFC 8188 — Encrypted Content-Encoding (aes128gcm): the on-the-wire body
//     layout (salt || rs || idlen || keyid || ciphertext), single record.
//
// The pure, deterministic helpers (base64url, concat, the HKDF "info" strings,
// JWT header/payload encoding) are exported so they can be unit-tested without a
// live push endpoint. The full encryption + POST (sendPush) is exercised
// end-to-end only against a real browser subscription — see the test file note.

import type { Env } from "./env";

// ---- byte helpers (pure) ----------------------------------------------------

const textEncoder = new TextEncoder();

/** Concatenate any number of byte arrays into one Uint8Array. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** base64url-encode bytes (no padding) — RFC 4648 §5 alphabet. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url-decode a string to bytes. Accepts standard base64 too (tolerant of
 *  padding). Throws on invalid input (callers validate / catch). */
export function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- HKDF (RFC 5869, SHA-256) ----------------------------------------------

/**
 * HKDF-SHA256: extract-then-expand. Returns `length` bytes of output keying
 * material derived from `ikm` with the given `salt` and `info`. Built on
 * crypto.subtle.deriveBits with the "HKDF" algorithm (Workers-native).
 *
 * RFC 8291 derives the PRK and the CEK/NONCE with HKDF where the SALT differs
 * per step (the subscription `auth` for the PRK step, the random message salt for
 * the CEK/NONCE steps) — this single helper covers all three.
 */
export async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ---- RFC 8291 §3.4 "info" construction (pure) ------------------------------

/**
 * Build the IKM-derivation `info` for the PRK step per RFC 8291 §3.4:
 *
 *   "WebPush: info" || 0x00 || ua_public(65) || as_public(65)
 *
 * where ua_public is the CLIENT (user-agent / subscription) raw P-256 public key
 * and as_public is the SERVER (application server / our ephemeral) raw P-256
 * public key — both 65-byte uncompressed points (0x04 || X(32) || Y(32)).
 * Order matters: client key first, then server key.
 */
export function buildKeyInfo(uaPublic: Uint8Array, asPublic: Uint8Array): Uint8Array {
  return concatBytes(
    textEncoder.encode("WebPush: info"),
    new Uint8Array([0]),
    uaPublic,
    asPublic,
  );
}

/** The aes128gcm content-encryption-key `info` (RFC 8188): "Content-Encoding: aes128gcm" || 0x00. */
export function cekInfo(): Uint8Array {
  return concatBytes(textEncoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0]));
}

/** The nonce `info` (RFC 8188): "Content-Encoding: nonce" || 0x00. */
export function nonceInfo(): Uint8Array {
  return concatBytes(textEncoder.encode("Content-Encoding: nonce"), new Uint8Array([0]));
}

// ---- VAPID JWT (RFC 8292, ES256) -------------------------------------------

/** The fixed VAPID JWT header, ES256. */
export function vapidHeader(): { typ: string; alg: string } {
  return { typ: "JWT", alg: "ES256" };
}

/**
 * Build the VAPID JWT claims for a target endpoint. `aud` is the scheme://host
 * origin of the push endpoint (NOT the full path). `exp` is capped to ≤24h in
 * the future (RFC 8292 §2 requires ≤24h); we default to now+12h.
 */
export function vapidClaims(
  endpoint: string,
  subject: string,
  nowSec: number,
  ttlSec = 12 * 3600,
): { aud: string; exp: number; sub: string } {
  const aud = new URL(endpoint).origin;
  const maxExp = nowSec + 24 * 3600;
  const exp = Math.min(nowSec + ttlSec, maxExp);
  return { aud, exp, sub: subject };
}

/** Encode a JSON object as a base64url JWT segment. */
export function encodeJwtSegment(obj: unknown): string {
  return base64UrlEncode(textEncoder.encode(JSON.stringify(obj)));
}

/** The signing input "<b64url(header)>.<b64url(payload)>" for a JWT. */
export function jwtSigningInput(header: unknown, payload: unknown): string {
  return `${encodeJwtSegment(header)}.${encodeJwtSegment(payload)}`;
}

/**
 * Sign the VAPID JWT with ES256. Imports the EC P-256 private key from the JWK
 * (env.VAPID_PRIVATE_JWK — a JSON string {kty:"EC",crv:"P-256",x,y,d}), signs the
 * "<header>.<payload>" input, and appends the base64url raw r||s (64-byte)
 * signature WebCrypto already produces for ECDSA. Returns the full JWT string.
 */
async function signVapidJwt(endpoint: string, env: Env, nowSec: number): Promise<string> {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signingInput = jwtSigningInput(vapidHeader(), vapidClaims(endpoint, env.VAPID_SUBJECT, nowSec));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textEncoder.encode(signingInput),
  );
  // WebCrypto ECDSA returns the raw r||s (64 bytes for P-256) — exactly the JWS
  // ES256 format, no DER unwrapping needed.
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

// ---- Subscription shape -----------------------------------------------------

export interface PushSubscription {
  endpoint: string;
  /** base64url client public key (65-byte uncompressed P-256 point). */
  p256dh: string;
  /** base64url client auth secret (16 bytes). */
  auth: string;
}

export interface SendPushOptions {
  /** Push message TTL in seconds (how long the service retains it). */
  ttlSec?: number;
  /** Urgency header (very-low|low|normal|high). */
  urgency?: "very-low" | "low" | "normal" | "high";
}

export interface SendPushResult {
  status: number;
  /** True when the push service says this subscription is gone (404/410) → the
   *  caller should delete it. */
  gone: boolean;
}

const RECORD_SIZE = 4096; // rs — a single record comfortably holds our small JSON.

/**
 * Encrypt `plaintext` for the subscription per RFC 8291 (aes128gcm, RFC 8188)
 * and return the full aes128gcm body. Pure-ish: it only touches Web Crypto (no
 * I/O). Layout of the returned body:
 *
 *   salt(16) || rs(4, big-endian) || idlen(1)=65 || keyid(=as_public, 65) || ciphertext
 *
 * The plaintext is padded with the RFC 8188 record delimiter 0x02 (single,
 * final record) before AES-128-GCM. The 16-byte GCM tag is appended by SubtleCrypto.
 */
async function encryptPayload(sub: PushSubscription, plaintext: Uint8Array): Promise<Uint8Array> {
  // Guard: one record must hold plaintext + the 0x02 delimiter + the 16-byte GCM
  // tag (single, final record). Reject oversized payloads up front rather than
  // emit an over-long record (protects future callers, e.g. long coach alarms).
  if (plaintext.length + 1 + 16 > RECORD_SIZE) {
    throw new Error("push payload too large for one record");
  }

  // 1. Ephemeral application-server ECDH keypair (the "as" key).
  const asKeyPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  // exportKey("raw", …) returns an ArrayBuffer for an EC public key; the
  // workers-types overload widens the return to a union, so narrow it here.
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", asKeyPair.publicKey)) as ArrayBuffer,
  ); // 65 bytes

  // 2. Import the client's (ua) public key (65-byte raw uncompressed point).
  const uaPublic = base64UrlDecode(sub.p256dh);
  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // 3. ECDH → 32-byte shared secret. NOTE on the peer-key field name: the WebCrypto
  // spec (and workerd at RUNTIME) require `public`, but @cloudflare/workers-types
  // declares the field as `$public`. They disagree, so we pass `public` (what the
  // runtime actually reads — verified by the ECDH-agreement test in
  // test/webpush.test.ts) and cast past the type. Using `$public` would typecheck
  // but THROW at runtime ("Missing field public in derivedKeyParams").
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asKeyPair.privateKey,
      256,
    ),
  );

  // 4. RFC 8291 §3.4 key derivation.
  const authSecret = base64UrlDecode(sub.auth); // 16 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info"||0x00||ua||as, L=32)
  const ikm = await hkdf(authSecret, ecdhSecret, buildKeyInfo(uaPublic, asPublic), 32);
  // CEK = HKDF(salt=message_salt, ikm=PRK, info="Content-Encoding: aes128gcm"||0x00, L=16)
  const cek = await hkdf(salt, ikm, cekInfo(), 16);
  // NONCE = HKDF(salt=message_salt, ikm=PRK, info="Content-Encoding: nonce"||0x00, L=12)
  const nonce = await hkdf(salt, ikm, nonceInfo(), 12);

  // 5. Pad (RFC 8188 single final record: plaintext || 0x02) and AES-128-GCM encrypt.
  const padded = concatBytes(plaintext, new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey("raw", cek as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 }, cekKey, padded as BufferSource),
  );

  // 6. Assemble the aes128gcm body header + ciphertext.
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false); // big-endian
  const idlen = new Uint8Array([asPublic.length]); // 65
  return concatBytes(salt, rs, idlen, asPublic, ciphertext);
}

/**
 * Send an encrypted Web Push notification to a single subscription.
 *
 * Builds the VAPID Authorization header (ES256 JWT signed with
 * env.VAPID_PRIVATE_JWK), encrypts `payloadObj` (JSON) with RFC 8291, and POSTs
 * the aes128gcm body to subscription.endpoint. Returns the HTTP status and
 * whether the subscription is GONE (404/410 → caller should delete it).
 *
 * Never throws on a normal HTTP failure; only a genuinely malformed
 * subscription / key import error propagates (the caller is responsible for
 * validating shape before storing, so this is a programming error if it fires).
 */
export async function sendPush(
  sub: PushSubscription,
  payloadObj: unknown,
  env: Env,
  opts: SendPushOptions = {},
): Promise<SendPushResult> {
  const ttlSec = opts.ttlSec ?? 2419200; // 28 days, the common default
  const urgency = opts.urgency ?? "normal";
  const nowSec = Math.floor(Date.now() / 1000);

  const plaintext = textEncoder.encode(JSON.stringify(payloadObj));
  const body = await encryptPayload(sub, plaintext);
  const jwt = await signVapidJwt(sub.endpoint, env, nowSec);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: String(ttlSec),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      // RFC 8292 §3.1: Authorization: vapid t=<jwt>, k=<base64url server public key>.
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      Urgency: urgency,
    },
    body: body as BodyInit,
  });

  // 404 (Not Found) / 410 (Gone) → the subscription has been retired by the
  // browser / push service; the caller deletes it. Anything else is left to the
  // caller (2xx = delivered to the service; 4xx/5xx = transient/our-error).
  const gone = res.status === 404 || res.status === 410;
  return { status: res.status, gone };
}

// Low-level crypto primitives, all built on the Workers-native Web Crypto API
// (crypto.subtle / crypto.getRandomValues). NO Node-only crypto, NO npm KDF that
// needs native bindings — everything here runs unchanged in the Workers runtime.
//
// Why PBKDF2 (not bcrypt/scrypt/argon2): the Cloudflare Workers runtime exposes
// Web Crypto, whose only password-grade KDF is PBKDF2. scrypt/argon2 are not in
// SubtleCrypto, and native bcrypt addons don't load in Workers. PBKDF2-HMAC-
// SHA256 with a high iteration count + a unique per-user salt is the correct,
// supported choice here. The stored algo tag ("pbkdf2-sha256$<iters>") lets us
// raise iterations / migrate KDF later WITHOUT a flag day: verify with the
// stored params, and (next stage) transparently re-hash on successful login.

/** PBKDF2 iteration count. The Cloudflare Workers runtime HARD-CAPS PBKDF2 at
 *  100,000 iterations — above that, crypto.subtle.deriveBits throws
 *  NotSupportedError ("iteration counts above 100000 are not supported"). So
 *  100k is the platform maximum here, not an arbitrary low value (OWASP's 600k
 *  floor isn't reachable on Workers). The iteration count is stored in the algo
 *  tag ("pbkdf2-sha256$<iters>"), so if Cloudflare ever raises the cap we can
 *  bump this and transparently re-hash on the next successful login — no flag
 *  day. NOTE: local miniflare/vitest does NOT enforce this cap, so a higher
 *  value passes tests but fails on the real edge — keep this at/below 100000. */
export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = "SHA-256";
const DERIVED_KEY_BITS = 256; // 32-byte derived key
const SALT_BYTES = 16;

const enc = new TextEncoder();

/** Cryptographically-strong random bytes → base64url (no padding). */
export function randomTokenBase64Url(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

/** Cryptographically-strong random bytes → standard base64. */
function randomBase64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Encode(buf);
}

// ---- Password hashing (PBKDF2-HMAC-SHA256) ---------------------------------

export interface PasswordRecord {
  hash: string; // base64 derived key
  salt: string; // base64 salt
  algo: string; // "pbkdf2-sha256$<iterations>"
}

/** Derive a PBKDF2 key for `password` against `saltBytes` at `iterations`. */
async function pbkdf2(password: string, saltBytes: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: PBKDF2_HASH },
    keyMaterial,
    DERIVED_KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Hash a NEW password: fresh random salt, current iteration count. */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const saltBytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(saltBytes);
  const derived = await pbkdf2(password, saltBytes, PBKDF2_ITERATIONS);
  return {
    hash: base64Encode(derived),
    salt: base64Encode(saltBytes),
    algo: `pbkdf2-sha256$${PBKDF2_ITERATIONS}`,
  };
}

/**
 * Verify a password against a stored record. Parses the iteration count from the
 * stored algo tag (so old hashes with fewer iterations still verify after we
 * raise the default). Constant-time comparison of the derived key. Returns false
 * — never throws — on any malformed/unknown record, so callers can treat it as a
 * plain auth failure (generic error, no info leak).
 */
export async function verifyPassword(password: string, record: PasswordRecord | null | undefined): Promise<boolean> {
  if (!record || !record.hash || !record.salt || !record.algo) return false;
  const m = /^pbkdf2-sha256\$(\d+)$/.exec(record.algo);
  if (!m) return false;
  const iterations = Number(m[1]);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 5_000_000) return false;

  let saltBytes: Uint8Array;
  let expected: Uint8Array;
  try {
    saltBytes = base64Decode(record.salt);
    expected = base64Decode(record.hash);
  } catch {
    return false;
  }
  const derived = await pbkdf2(password, saltBytes, iterations);
  return timingSafeEqual(derived, expected);
}

/**
 * Equal-cost dummy verify for the user-absent / no-password-credential path on
 * login. It runs ONE full PBKDF2 at the current iteration count against a fixed
 * dummy record — exactly the work a real verifyPassword() does — so login
 * response time is constant whether or not the account exists (or has a
 * password). It always returns false. NEVER skip this on the absent path:
 * skipping it is the user-enumeration timing leak this guards against.
 *
 * The dummy record's salt/hash are fixed, in-process constants (NOT a secret and
 * NOT a real credential): all that matters is that the KDF runs at full cost.
 */
const DUMMY_SALT_B64 = base64Encode(new Uint8Array(SALT_BYTES)); // 16 zero bytes
const DUMMY_HASH_B64 = base64Encode(new Uint8Array(DERIVED_KEY_BITS / 8)); // 32 zero bytes
const DUMMY_RECORD: PasswordRecord = {
  hash: DUMMY_HASH_B64,
  salt: DUMMY_SALT_B64,
  algo: `pbkdf2-sha256$${PBKDF2_ITERATIONS}`,
};

export async function dummyVerify(password: string): Promise<boolean> {
  // Runs a real PBKDF2 at PBKDF2_ITERATIONS, then a constant-time compare that
  // can never match the all-zero dummy hash → always false, but full cost.
  return verifyPassword(password, DUMMY_RECORD);
}

// ---- Session token hashing -------------------------------------------------

/** SHA-256 of a string → base64. Used to store session tokens hashed (a DB leak
 *  can't be replayed: the cookie holds the secret, the DB holds only its hash). */
export async function sha256Base64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return base64Encode(new Uint8Array(digest));
}

// ---- PKCE (OAuth) ----------------------------------------------------------

/** Generate a PKCE pair: a high-entropy verifier and its S256 challenge. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomTokenBase64Url(32); // 43 chars, within RFC 7636 bounds
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

/** A CSRF/state/nonce-grade random opaque value. */
export function randomOpaque(): string {
  return randomTokenBase64Url(32);
}

export { randomBase64 };

// ---- Constant-time compare -------------------------------------------------

/** Length-independent, constant-time byte comparison (no early-exit leak). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Compare into a fixed accumulator. We still fold the length difference in so
  // a length mismatch can never short-circuit and can never read out of bounds.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Constant-time compare of two strings (for CSRF token / opaque token checks). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

// ---- base64 helpers (no Node Buffer; pure runtime APIs) --------------------

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

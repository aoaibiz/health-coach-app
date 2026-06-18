// Input validation — allow-list discipline (mirrors the existing app's style in
// functions/api/chat.ts). Reject anything that doesn't match the exact shape;
// never pass untrusted input through raw. All validators are pure + testable.

/** Trim + lowercase an email for storage/comparison (case-insensitive accounts). */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  // Pragmatic RFC-5321-ish check: local@domain.tld, no spaces/controls, bounded.
  // Intentionally conservative — we'd rather reject an exotic-but-valid address
  // than accept an injection vector. Length cap guards storage + log abuse.
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^\s@"'`<>\\]+@[^\s@"'`<>\\]+\.[^\s@"'`<>\\]{2,}$/.test(e)) return null;
  return e;
}

/**
 * Password policy: length-bounded. We require a reasonable minimum and cap the
 * maximum (PBKDF2 cost is independent of length, but an unbounded password is a
 * DoS vector and pointless). We do NOT impose composition rules (NIST 800-63B
 * advises length over composition); the cap is well below any practical limit.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function validatePassword(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "パスワードを入力してください" };
  // Count Unicode code points, not UTF-16 units, so emoji etc. count fairly.
  const len = [...raw].length;
  if (len < PASSWORD_MIN) return { ok: false, reason: `パスワードは${PASSWORD_MIN}文字以上にしてください` };
  if (len > PASSWORD_MAX) return { ok: false, reason: `パスワードは${PASSWORD_MAX}文字以内にしてください` };
  return { ok: true, value: raw };
}

/** A short, single-line display name (optional field). Control chars stripped. */
export function cleanDisplayName(raw: unknown, max = 60): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "").trim().slice(0, max);
  return s.length > 0 ? s : null;
}

/** Allowed per-user data sections (the seam to the app's localStorage keys). */
export const DATA_SECTIONS = ["profile", "meals", "workouts"] as const;
export type DataSection = (typeof DATA_SECTIONS)[number];

export function isDataSection(s: unknown): s is DataSection {
  return typeof s === "string" && (DATA_SECTIONS as readonly string[]).includes(s);
}

/** Max stored blob size per section (bounds D1 row size + abuse). */
export const MAX_DATA_BLOB_BYTES = 256 * 1024; // 256 KB

/**
 * Validate a per-user data payload: must be a JSON-serializable object/array
 * within the size cap. Returns the canonical JSON string to store. The backend
 * treats the contents as opaque (the app owns the schema) but enforces that it's
 * valid JSON and bounded, so a row can't be poisoned with non-JSON or be huge.
 */
export function validateDataPayload(
  value: unknown,
): { ok: true; json: string } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object") {
    return { ok: false, reason: "data はオブジェクトまたは配列である必要があります" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, reason: "data をJSONに変換できませんでした" };
  }
  // Byte length, not char length (multibyte content).
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > MAX_DATA_BLOB_BYTES) {
    return { ok: false, reason: "data が大きすぎます" };
  }
  return { ok: true, json: serialized };
}

// ---- Web Push subscription validation --------------------------------------

/** Max push subscriptions per user (a user with this many devices is unusual;
 *  the cap bounds row growth + the /api/push/test fan-out cost). */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20;

/** Bounds on the subscription fields (defensive — push endpoints are short URLs;
 *  the keys are fixed-size base64url). */
const MAX_ENDPOINT_LEN = 2048;
const MAX_KEY_LEN = 256;

/**
 * The set of REAL browser push services. A subscription endpoint is a handle on
 * one of these — never an arbitrary host. Restricting POSTs to this allow-list
 * closes an authenticated SSRF-style vector: without it, a logged-in user could
 * register `https://internal-host/...` as their "endpoint" and have the Worker
 * POST an encrypted body to it via /api/push/test. The list is by browser:
 *   * fcm.googleapis.com          — Chrome / Android (FCM), an EXACT host
 *   * .push.services.mozilla.com  — Firefox (autopush), a host SUFFIX
 *   * .notify.windows.com         — Edge / Windows (WNS), a host SUFFIX
 *   * .push.apple.com             — Safari / iOS / macOS (APNs web push), a SUFFIX
 * EXTEND this if a new browser ships its own push service (the only safe way to
 * widen the allow-list).
 */
const ALLOWED_PUSH_ENDPOINT_HOSTS = {
  /** Matched with hostname === host. */
  exact: ["fcm.googleapis.com"],
  /** Matched with hostname.endsWith(suffix) (the leading dot anchors a real
   *  sub-domain boundary, so "fcm.googleapis.com.evil.com" can't match). */
  suffixes: [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"],
} as const;

/**
 * True iff `urlString` is an https URL whose hostname is a known browser push
 * service (see ALLOWED_PUSH_ENDPOINT_HOSTS). Exported so it's unit-testable in
 * isolation. Rejects non-https, unparseable URLs, and look-alike hosts.
 */
export function isAllowedPushEndpoint(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if ((ALLOWED_PUSH_ENDPOINT_HOSTS.exact as readonly string[]).includes(host)) return true;
  return ALLOWED_PUSH_ENDPOINT_HOSTS.suffixes.some((suffix) => host.endsWith(suffix));
}

export interface ValidPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** base64url charset only (the client keys + the body decoding rely on this). */
function isBase64Url(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** Decode a base64url string to bytes; null on any malformed input (so callers
 *  validate sizes without a throw). Mirrors webpush.ts base64UrlDecode but is
 *  fail-soft (returns null) since this runs on untrusted client input. */
function decodeBase64Url(s: string): Uint8Array | null {
  try {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Exact decoded sizes for the RFC 8291 client keys: p256dh is a 65-byte
 *  uncompressed P-256 point (0x04 || X(32) || Y(32)); auth is a 16-byte secret. */
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;

/**
 * Validate a Web Push subscription as sent by the browser PushManager:
 *   { endpoint: string (https URL), keys: { p256dh: base64url, auth: base64url } }
 * The endpoint MUST be an absolute https URL (push services are always https) so
 * we never POST to an arbitrary scheme. Returns the flattened, bounded fields.
 */
export function validatePushSubscription(
  body: unknown,
): { ok: true; value: ValidPushSubscription } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "リクエストが不正です" };
  const b = body as { endpoint?: unknown; keys?: unknown };

  const endpoint = b.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LEN) {
    return { ok: false, reason: "endpoint が不正です" };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "endpoint が不正です" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "endpoint が不正です" };
  // Must be a real browser push service (closes authenticated SSRF-style POST).
  if (!isAllowedPushEndpoint(endpoint)) return { ok: false, reason: "invalid_push_endpoint" };

  const keys = b.keys;
  if (!keys || typeof keys !== "object") return { ok: false, reason: "keys が不正です" };
  const k = keys as { p256dh?: unknown; auth?: unknown };
  if (!isBase64Url(k.p256dh) || k.p256dh.length > MAX_KEY_LEN) return { ok: false, reason: "p256dh が不正です" };
  if (!isBase64Url(k.auth) || k.auth.length > MAX_KEY_LEN) return { ok: false, reason: "auth が不正です" };

  // Decode + size-check the keys now so we never store junk that only fails at
  // send time: p256dh = 65-byte uncompressed P-256 point (first byte 0x04),
  // auth = 16-byte secret (RFC 8291).
  const p256dhBytes = decodeBase64Url(k.p256dh);
  const authBytes = decodeBase64Url(k.auth);
  if (!p256dhBytes || p256dhBytes.length !== P256DH_BYTES || p256dhBytes[0] !== 0x04) {
    return { ok: false, reason: "invalid_push_keys" };
  }
  if (!authBytes || authBytes.length !== AUTH_BYTES) {
    return { ok: false, reason: "invalid_push_keys" };
  }

  return { ok: true, value: { endpoint, p256dh: k.p256dh, auth: k.auth } };
}

/** Validate an unsubscribe body: { endpoint: string (https URL) }. */
export function validateUnsubscribe(body: unknown): { ok: true; endpoint: string } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "リクエストが不正です" };
  const endpoint = (body as { endpoint?: unknown }).endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LEN) {
    return { ok: false, reason: "endpoint が不正です" };
  }
  try {
    if (new URL(endpoint).protocol !== "https:") return { ok: false, reason: "endpoint が不正です" };
  } catch {
    return { ok: false, reason: "endpoint が不正です" };
  }
  return { ok: true, endpoint };
}

/** A safe relative redirect path (post-login landing). Rejects absolute URLs,
 *  protocol-relative ("//evil"), and anything with control chars — open-redirect
 *  defense for the OAuth `redirect_after`. */
export function safeRelativePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s.startsWith("/")) return null; // must be relative to the app
  if (s.startsWith("//")) return null; // protocol-relative → external
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(s)) return null;
  if (s.length > 512) return null;
  return s;
}

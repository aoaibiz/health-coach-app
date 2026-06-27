// Web Push client helpers — browser side of the notifications feature.
//
// Pairs with the live Cloudflare Worker backend (see authApi.ts: getVapidPublicKey,
// pushSubscribe, pushUnsubscribe, pushTest) and the root service worker (/sw.js).
//
// Static-export-safe: the only thing imported at module load that touches the
// VAPID constant is a string; every browser API (navigator, window, Notification,
// PushManager) is accessed lazily *inside* functions, all guarded by
// isPushSupported(), so this module imports cleanly in SSG/Node.

import { getVapidPublicKey, pushSubscribe, pushTest, pushUnsubscribe, type PushTestResult } from "./authApi";

/**
 * The current notification state, derived from Notification.permission +
 * whether a PushManager subscription exists. Drives the 通知 UI.
 *  - "unsupported"  : this browser can't do Web Push (or not in a secure ctx).
 *  - "denied"       : the user blocked notifications (must re-enable in browser).
 *  - "default"      : not asked yet → show the primary "オンにする" button.
 *  - "subscribed"   : permission granted AND we have a live push subscription.
 *  - "unsubscribed" : permission granted but no subscription (re-enable to re-sub).
 */
export type PushStatus =
  | "unsupported"
  | "denied"
  | "default"
  | "subscribed"
  | "unsubscribed";

/**
 * Bundled VAPID public key — used only as a fallback if the (more authoritative)
 * GET /api/push/public-key fetch fails. Fetching is preferred so a server key
 * rotation doesn't require a redeploy.
 */
const FALLBACK_VAPID_PUBLIC_KEY =
  "BOzlwBTRyg5_Ip2BKnrdh6BSmDPijVkyoUTSzR-855XqkHVmezMyQNfNKKxztqo5PDTv_BJjDsMH5-o_R3YMjW0";

/**
 * Standard VAPID base64url → Uint8Array conversion for applicationServerKey.
 * Backed by a fresh, concrete ArrayBuffer so the result is assignable to the
 * (ArrayBuffer-typed) BufferSource that PushManager.subscribe expects under
 * TS 5.9's typed-array generics.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** True only when this browser supports the full Web Push stack. */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Register the root-scoped service worker. Idempotent: navigator.serviceWorker
 * .register('/sw.js') no-ops if the same SW is already registered. Returns the
 * ready registration, or null when unsupported. Registration alone does NOT
 * prompt for permission — that only happens in enablePush().
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    await navigator.serviceWorker.register("/sw.js");
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/** Derive the current PushStatus from permission + existing subscription. */
export async function getPushStatus(): Promise<PushStatus> {
  if (!isPushSupported()) return "unsupported";
  const permission = Notification.permission;
  if (permission === "denied") return "denied";
  if (permission === "default") return "default";

  // permission === "granted" → check whether we actually hold a subscription.
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) return "unsubscribed";
    const sub = await reg.pushManager.getSubscription();
    return sub ? "subscribed" : "unsubscribed";
  } catch {
    return "unsubscribed";
  }
}

/**
 * Turn notifications ON:
 *   request permission → register SW → subscribe with the VAPID key →
 *   POST the subscription to the backend. Returns the resulting PushStatus.
 *
 * If the user denies permission we return "denied" (no throw) so the UI can show
 * the "re-enable in browser settings" hint gracefully.
 */
export async function enablePush(csrfToken: string | null): Promise<PushStatus> {
  if (!isPushSupported()) return "unsupported";

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "default";
  }

  const reg = await registerServiceWorker();
  if (!reg) return "unsubscribed";

  // Re-use an existing subscription if present; otherwise create a new one.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const publicKey = await fetchVapidKey();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  // subscription.toJSON() → { endpoint, keys: { p256dh, auth }, ... }.
  const json = sub.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    // Malformed subscription — surface as "not subscribed" rather than guessing.
    return "unsubscribed";
  }
  await pushSubscribe({ endpoint, keys: { p256dh, auth } }, csrfToken);
  return "subscribed";
}

/**
 * Turn notifications OFF: unsubscribe locally + tell the backend to drop the
 * endpoint. Returns the resulting status ("unsubscribed", or "denied"/"default"
 * if permission isn't granted). Best-effort: a local unsubscribe still happens
 * even if the server call is skipped (no endpoint).
 */
export async function disablePush(csrfToken: string | null): Promise<PushStatus> {
  if (!isPushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => undefined);
    if (endpoint) {
      await pushUnsubscribe({ endpoint }, csrfToken);
    }
  }
  return getPushStatus();
}

/** Ask the backend to send a test push to this user's subscriptions. */
export async function sendTestPush(csrfToken: string | null): Promise<PushTestResult> {
  return pushTest(csrfToken);
}

/** Fetch the VAPID key from the backend; fall back to the bundled constant. */
async function fetchVapidKey(): Promise<string> {
  try {
    return await getVapidPublicKey();
  } catch {
    return FALLBACK_VAPID_PUBLIC_KEY;
  }
}

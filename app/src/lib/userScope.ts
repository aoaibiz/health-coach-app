// User-scope data isolation (PRIVACY-CRITICAL).
//
// WHY THIS EXISTS: every user record lives in per-DEVICE localStorage (+ IndexedDB
// photos), addressed by fixed keys that are NOT namespaced per user. The auth layer
// only ever cleared the auth STATE on logout, never the data. So on a shared
// browser:
//   user A logs in → enters data (profile/meals/chat/…) → logs out (data stays in
//   localStorage) → user B registers/logs in → the app mounts against A's leftover
//   local data → B SEES A's data.  ← the privacy bug.
//
// THE FIX (data ownership at the user boundary):
//   - Track the last user bound to this browser (`health-app:lastUserId`).
//   - On login, if the user CHANGED (≠ lastUserId) → wipe ALL local user data so
//     nothing from the previous user can surface for the new user.
//   - On logout → wipe ALL local user data, so the next person on a shared device
//     starts clean.
//   - Same user continuing (== lastUserId) or first-ever login on this browser
//     (no lastUserId) → DO NOT wipe; the user keeps their own offline-created data.
//
// This is the ONLY place that enumerates the user-data keys, so a future section
// can't be forgotten: add its key to USER_DATA_KEYS and it's cleared everywhere.
//
// NOTE: this app stores user data LOCAL-ONLY (no cross-device server sync), so the
// fix is a straight wipe — there is no server merge to sequence against.
//
// SSR-safe: every function is a no-op when `window` is absent.

import type { AuthUser } from "./authState";
import { API_TOKEN_STORAGE_KEY } from "./analyzeMeal";
import { COACH_SETTINGS_KEY } from "./coachSettings";
import { WEIGHT_LOG_STORAGE_KEY } from "./weightLog";
import { CHAT_STORAGE_KEY } from "./chatStore";
import { SELECTED_DATE_KEY } from "./selectedDate";

/** localStorage key recording the user currently bound to THIS browser, so a
 *  login by a DIFFERENT user can be detected and the previous user's data wiped.
 *  Value is the identity key from `userIdentityKey`. */
export const LAST_USER_ID_KEY = "health-app:lastUserId";

// The fixed (un-namespaced) localStorage keys that hold USER DATA. Re-declared
// here as the single clear-list rather than importing every module's private
// const, because some keys (meals/workouts/profile/sleep) are module-private. A
// test pins this list against the real source-of-truth keys so it can't drift.
const MEALS_KEY = "health-app:meals:v1";
const WORKOUTS_KEY = "health-app:workouts:v1";
const PROFILE_KEY = "health-app:profile:v1";
const SLEEP_KEY = "health-app:sleep:v1";

/**
 * EVERY localStorage key that holds USER DATA or per-user state. Clearing these
 * (on logout / on a different-user login) removes the previous user's footprint.
 *
 * Deliberately EXCLUDES:
 *   - `health-app:theme:v1`   — a device display PREFERENCE, not user data. Wiping
 *                                it on logout would flash the wrong theme for the
 *                                next person and is not a privacy concern.
 *   - `health-app:lastUserId` — handled separately (it is the bookkeeping key that
 *                                drives this very logic; cleared on logout only).
 */
export const USER_DATA_KEYS: readonly string[] = [
  PROFILE_KEY,
  MEALS_KEY,
  WORKOUTS_KEY,
  WEIGHT_LOG_STORAGE_KEY,
  COACH_SETTINGS_KEY,
  CHAT_STORAGE_KEY,
  API_TOKEN_STORAGE_KEY,
  SLEEP_KEY,
  SELECTED_DATE_KEY,
];

/** IndexedDB database + store that hold meal/avatar photo BLOBs (photoStore.ts).
 *  Cleared wholesale on a user switch / logout so the previous user's photos
 *  (meal pictures + profile avatar) don't linger for the next person. */
const PHOTO_DB_NAME = "health-app";
const PHOTO_STORE = "photos";

/**
 * Derive a STABLE per-user identity key from the auth user object, used to detect
 * "is this the same user as last time on this browser?".
 *
 * Robust to the API's response SHAPE: authApi splits `{ csrfToken, ...user }` from
 * the login/me response, so `state.user` is normally the flat `{ id, email, … }`.
 * We still also look at a nested `.user` in case a backend returns the fields
 * NESTED, preferring a stable `id` over `email`. Returns "" when no identity can be
 * derived (treated as "unknown user").
 */
export function userIdentityKey(user: AuthUser | null | undefined): string {
  if (!user || typeof user !== "object") return "";
  const top = user as Record<string, unknown>;
  const nested =
    top.user && typeof top.user === "object"
      ? (top.user as Record<string, unknown>)
      : undefined;

  const id = pickString(top.id) || (nested ? pickString(nested.id) : "");
  if (id) return `id:${id}`;
  const email =
    pickString(top.email) || (nested ? pickString(nested.email) : "");
  if (email) return `email:${email.toLowerCase()}`;
  return "";
}

function pickString(v: unknown): string {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : "";
}

/**
 * True if ANY user-data key currently exists in localStorage. Used to fail closed
 * when the authed user's identity can't be derived (no id/email) AND there is no
 * recorded `lastUserId` to match against: if leftover user data exists we cannot
 * prove it belongs to this session's user, so the caller wipes rather than expose
 * it. Covers the pre-fix-upgrade path (data on disk, lastUserId never recorded).
 * SSR-safe: false when `window` is absent.
 */
export function hasAnyUserData(): boolean {
  if (typeof window === "undefined") return false;
  for (const key of USER_DATA_KEYS) {
    try {
      if (window.localStorage.getItem(key) != null) return true;
    } catch {
      /* storage unavailable → treat as no data */
    }
  }
  return false;
}

/** Read the user bound to this browser, or null when none is recorded. */
export function getLastUserId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(LAST_USER_ID_KEY);
    return v && v.trim() !== "" ? v : null;
  } catch {
    return null;
  }
}

/** Record the user now bound to this browser. No-op on SSR / empty key. */
export function setLastUserId(identity: string): void {
  if (typeof window === "undefined") return;
  if (!identity) return;
  try {
    window.localStorage.setItem(LAST_USER_ID_KEY, identity);
  } catch {
    /* quota / private mode — non-fatal */
  }
}

/** Forget the browser-bound user (on logout). No-op on SSR. */
export function clearLastUserId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LAST_USER_ID_KEY);
  } catch {
    /* non-fatal */
  }
}

/**
 * Remove EVERY user-data localStorage key (USER_DATA_KEYS) AND every photo blob
 * in IndexedDB. Used when a DIFFERENT user logs in and on logout. NEVER touches
 * the theme preference or the lastUserId bookkeeping key (the caller manages
 * lastUserId explicitly). Best-effort + never throws — a partial clear must not
 * crash the auth flow.
 *
 * Returns a promise that resolves once the IndexedDB clear settles; the
 * localStorage portion is synchronous (done before the await) so callers that
 * don't await still get a clean localStorage immediately.
 */
export async function clearAllLocalData(): Promise<void> {
  if (typeof window === "undefined") return;
  // 1) localStorage — synchronous, do it first so any immediately-following read
  //    sees an empty section.
  for (const key of USER_DATA_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* keep going — clearing the rest still reduces leakage */
    }
  }
  // 2) IndexedDB photos (meal + avatar blobs). Best-effort; await so the caller
  //    can sequence after a complete wipe.
  try {
    await clearPhotoStore();
  } catch {
    /* non-fatal: localStorage (which drives the visible UI) is already cleared */
  }
}

/** Clear the photos object store (meal photos + profile avatars). Resolves even
 *  when IndexedDB is unavailable; never rejects fatally to the caller. */
function clearPhotoStore(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(PHOTO_DB_NAME);
    } catch {
      done();
      return;
    }
    req.onerror = done;
    req.onsuccess = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          db.close();
          done();
          return;
        }
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.objectStore(PHOTO_STORE).clear();
        tx.oncomplete = () => {
          db.close();
          done();
        };
        tx.onerror = () => {
          db.close();
          done();
        };
        tx.onabort = () => {
          db.close();
          done();
        };
      } catch {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        done();
      }
    };
    // Guard against a hung open (blocked by another tab) — never hang the auth flow.
    req.onblocked = done;
  });
}

// Durable sync for the access key (アクセスキー).
//
// WHY THIS EXISTS: the access key that unlocks the AI features lived ONLY in
// per-device localStorage under `health-app:apiToken` (see analyzeMeal.ts). When
// a user removed and re-added the installed app, or switched devices, the key was
// gone and they had to paste it again by hand. This module backs the key up to
// the same authenticated per-user data API every other section uses, so a delete
// → re-add → login restores it automatically — NO manual re-entry.
//
// HOW IT FITS THE EXISTING SYNC: the access key is a single short STRING, but the
// server's data API only accepts an OBJECT/array blob (validateDataPayload rejects
// scalars/null). So we sync a small ENVELOPE `{ token, updatedAt }`. The raw token
// itself still lives under the ORIGINAL `health-app:apiToken` key so EVERY existing
// reader (analyzeMeal.ts / chat.ts / ProfileForm) is unchanged; this module keeps
// a companion `updatedAt` so the cross-device merge can be newest-wins (mirrors the
// profile's updatedAt strategy). A blank token can never overwrite a real one.
//
// All functions are PURE-ish (read/write localStorage; SSR-safe → no-op/empty on
// the server) so the merge is unit-testable, exactly like coachSettings.ts.

import { API_TOKEN_STORAGE_KEY } from "./analyzeMeal";

/** Companion key holding the access key's last-changed ISO timestamp, so a
 *  cross-device merge keeps the NEWER key (the raw value stays under
 *  API_TOKEN_STORAGE_KEY for all existing readers). */
export const API_TOKEN_UPDATED_AT_KEY = "health-app:apiToken:updatedAt";

/** Defensive upper bound on a stored access key (it is a short opaque token, not
 *  free text). Bounds the synced blob + guards against a junk paste. */
export const MAX_API_TOKEN_CHARS = 512;

/**
 * The synced shape for the access key. `token` is the (trimmed) key or "" when
 * unset; `updatedAt` is an ISO timestamp of the last local change (absent → "").
 * An EMPTY token is a valid state (the user cleared their key) but, per the merge
 * rule below, can never overwrite a non-empty key from another device.
 */
export interface ApiTokenData {
  token: string;
  updatedAt: string;
}

/** Trim + clamp a raw token to a single safe value. Pure. */
export function sanitizeToken(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // Strip control chars (a token is opaque ASCII-ish; newlines/etc. are never
  // part of it and would only come from a bad paste) then trim + clamp.
  return raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "")
    .trim()
    .slice(0, MAX_API_TOKEN_CHARS);
}

/** Validate/normalise a raw parsed value (server blob OR local) into a clean
 *  ApiTokenData. Pure — mirrors sanitizeCoachSettings. */
export function sanitizeApiTokenData(raw: unknown): ApiTokenData {
  if (!raw || typeof raw !== "object") return { token: "", updatedAt: "" };
  const r = raw as Record<string, unknown>;
  return {
    token: sanitizeToken(r.token),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
}

/** Read the current access key + its companion updatedAt from localStorage.
 *  SSR-safe (returns an empty envelope). The token comes from the ORIGINAL key
 *  so it always reflects what the existing readers see. */
export function loadApiTokenData(): ApiTokenData {
  if (typeof window === "undefined") return { token: "", updatedAt: "" };
  try {
    const token = sanitizeToken(window.localStorage.getItem(API_TOKEN_STORAGE_KEY));
    const updatedAt = window.localStorage.getItem(API_TOKEN_UPDATED_AT_KEY) ?? "";
    return { token, updatedAt: typeof updatedAt === "string" ? updatedAt : "" };
  } catch {
    return { token: "", updatedAt: "" };
  }
}

/**
 * Persist an access key envelope locally: writes the raw token to the ORIGINAL
 * key (so all existing readers pick it up) and records the updatedAt companion.
 * A blank token REMOVES the original key (matching ProfileForm's current clear
 * behaviour) but still records the updatedAt of the clear, so an intentional
 * clear can win over an older non-empty key on the SAME device timeline.
 */
export function saveApiTokenData(data: ApiTokenData): void {
  if (typeof window === "undefined") return;
  const clean = sanitizeApiTokenData(data);
  try {
    if (clean.token) {
      window.localStorage.setItem(API_TOKEN_STORAGE_KEY, clean.token);
    } else {
      window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
    }
    if (clean.updatedAt) {
      window.localStorage.setItem(API_TOKEN_UPDATED_AT_KEY, clean.updatedAt);
    } else {
      window.localStorage.removeItem(API_TOKEN_UPDATED_AT_KEY);
    }
  } catch {
    /* quota/availability errors are non-fatal; the API fails honestly with 401 */
  }
}

/**
 * Set the access key from the UI (or clear it with ""), stamping updatedAt=now so
 * a later cross-device merge keeps THIS change when it is the newer one. Returns
 * the envelope written. Call this from the settings form instead of poking
 * localStorage directly, so the companion timestamp is always kept in sync.
 */
export function setApiToken(rawToken: string): ApiTokenData {
  const data: ApiTokenData = {
    token: sanitizeToken(rawToken),
    updatedAt: new Date().toISOString(),
  };
  saveApiTokenData(data);
  return data;
}

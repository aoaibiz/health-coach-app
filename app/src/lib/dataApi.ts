// Thin client for the authenticated per-user data API (Stage 2 — durable data).
//
//   GET  /api/user/data?section=<section>  → { section, data, updatedAt }
//   PUT  /api/user/data?section=<section>  body { data } → { section, updatedAt }
//
// Same cross-subdomain rules as authApi.ts: EVERY call uses credentials:"include"
// so the HttpOnly session cookie travels (the user_id is derived server-side from
// the session — the client can never address another user's data), and the
// state-changing PUT also sends X-CSRF-Token. The server treats each section's
// blob as opaque JSON; the schema is owned client-side (see syncData.ts).
//
// Static-export-safe: NO top-level window/localStorage access.

import { HEALTH_API_BASE, AuthApiError } from "./authApi";

/** The localStorage-section names the server persists (mirrors the Worker's
 *  DATA_SECTIONS allow-list). Each maps 1:1 to a localStorage key. */
export type DataSection =
  | "profile"
  | "meals"
  | "workouts"
  | "weightLog"
  | "coachSettings"
  | "chat"
  // The access key (アクセスキー), synced so a device delete/re-add restores it
  // automatically. Stored as a small { token, updatedAt } envelope — see
  // apiTokenStore.ts — because the server only accepts an object/array blob.
  | "apiToken"
  // Delete TOMBSTONES (cross-device delete tracking) — see deletionsStore.ts.
  // A small object { [section]: { [id]: deletedAt } } so a record removed on one
  // device stays removed on the others (the union merge would otherwise re-add
  // it). Synced like any other section.
  | "deletions";

export const DATA_SECTIONS: readonly DataSection[] = [
  "profile",
  "meals",
  "workouts",
  "weightLog",
  "coachSettings",
  "chat",
  "apiToken",
  "deletions",
];

/** Result of GET /api/user/data. `data` is null when the user has no row yet
 *  (first run is normal, NOT an error). `updatedAt` is unix seconds or null. */
export interface GetDataResult {
  section: DataSection;
  data: unknown;
  updatedAt: number | null;
}

/** Test seam: callers (and tests) can inject a fetch implementation. */
export interface FetchOption {
  fetchImpl?: typeof fetch;
}

function pickFetch(opts?: FetchOption): typeof fetch {
  return opts?.fetchImpl ?? fetch;
}

function apiUrl(section: DataSection): string {
  return `${HEALTH_API_BASE}/api/user/data?section=${encodeURIComponent(section)}`;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * GET a section's server-stored blob. Returns { data: null, updatedAt: null }
 * when the user has no row yet. Throws AuthApiError on 401 (unauthenticated) or
 * any other non-2xx so the caller can decide (the sync layer treats a throw as
 * "server unavailable — keep local untouched", never as "server is empty").
 */
export async function getData(
  section: DataSection,
  opts?: FetchOption,
): Promise<GetDataResult> {
  const res = await pickFetch(opts)(apiUrl(section), {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    throw new AuthApiError(res.status, "データの取得に失敗しました");
  }
  const obj = ((await safeJson(res)) ?? {}) as {
    data?: unknown;
    updatedAt?: unknown;
  };
  return {
    section,
    data: obj.data ?? null,
    updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : null,
  };
}

/**
 * PUT a section's blob. State-changing → credentials + X-CSRF-Token. Returns the
 * server's new updatedAt (unix seconds). Throws AuthApiError on any non-2xx.
 * `data` must be a JSON object/array (the server rejects scalars/null).
 */
export async function putData(
  section: DataSection,
  data: unknown,
  csrfToken: string | null,
  opts?: FetchOption,
): Promise<number | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await pickFetch(opts)(apiUrl(section), {
    method: "PUT",
    credentials: "include",
    headers,
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    throw new AuthApiError(res.status, "データの保存に失敗しました");
  }
  const obj = ((await safeJson(res)) ?? {}) as { updatedAt?: unknown };
  return typeof obj.updatedAt === "number" ? obj.updatedAt : null;
}

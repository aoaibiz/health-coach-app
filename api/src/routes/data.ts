// Authenticated per-user data API — the seam the app wires to next.
//
//   GET /api/user/data?section=profile|meals|workouts
//   PUT /api/user/data?section=...   (body: { data: <json> })
//
// Auth is enforced by the router (a valid session is required; PUT also passes
// CSRF). These handlers receive the resolved user id, so a user can only ever
// read/write THEIR OWN rows — there is no path to address another user's data
// (the user_id is server-derived from the session, never from the request).

import type { Env } from "../lib/env";
import { json, errorJson } from "../lib/http";
import { isDataSection, validateDataPayload } from "../lib/validate";
import { getUserData, putUserData } from "../lib/db";

export async function handleGetData(req: Request, env: Env, userId: string): Promise<Response> {
  const section = new URL(req.url).searchParams.get("section");
  if (!isDataSection(section)) return errorJson("invalid_section", "section が不正です", 400);

  const row = await getUserData(env, userId, section);
  if (!row) {
    // No data yet for this section → empty, not an error (first-run is normal).
    return json({ section, data: null, updatedAt: null });
  }
  // `data` is stored as a JSON string; parse so the client gets structured JSON.
  let data: unknown = null;
  try {
    data = JSON.parse(row.data);
  } catch {
    // Should never happen (we only ever store validated JSON), but never 500 on
    // a corrupt row — return null so the client treats it as empty.
    data = null;
  }
  return json({ section, data, updatedAt: row.updated_at });
}

export async function handlePutData(req: Request, env: Env, userId: string): Promise<Response> {
  const section = new URL(req.url).searchParams.get("section");
  if (!isDataSection(section)) return errorJson("invalid_section", "section が不正です", 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson("bad_request", "リクエストが不正です", 400);
  }
  if (!body || typeof body !== "object") return errorJson("bad_request", "リクエストが不正です", 400);

  const payload = (body as { data?: unknown }).data;
  const valid = validateDataPayload(payload);
  if (!valid.ok) return errorJson("invalid_data", valid.reason, 400);

  const updatedAt = await putUserData(env, userId, section, valid.json);
  return json({ section, updatedAt });
}

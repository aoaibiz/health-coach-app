// Durable cross-device data sync (Stage 2).
//
// WHY THIS EXISTS: every user record used to live ONLY in per-device
// localStorage. Clearing the browser or switching devices lost everything
// (Ao's family nearly lost their data). This module backs that data up to the
// authenticated server API and merges across devices on login.
//
// ───────────────────────────────────────────────────────────────────────────
// THE #1 RULE — NEVER DISCARD LOCAL BEFORE A SUCCESSFUL SERVER SAVE.
//
// Every merge here is a UNION: a record present on EITHER side is always in the
// result. An empty / missing / failed server response can therefore NEVER delete
// a local record. We only ever ADD to local; we never subtract from it during a
// sync. A server fetch that THROWS (offline, 5xx, 401) is treated as "server
// unknown" — we keep local exactly as-is and try again next time. See
// mergeOnLogin's guard.
//
// CROSS-DEVICE DELETES — handled via TOMBSTONES (see deletionsStore.ts).
// A pure union would re-add a record deleted on one device from another device's
// copy ("削除しても戻ってくる"). To make a delete STICK across devices without
// reintroducing data-loss, deletes record a tombstone { id, deletedAt } in a
// separately-synced `deletions` blob. The `deletions` section is merged FIRST
// (its own union, latest-deletedAt wins), then every id-keyed section's union has
// tombstoned ids EXCLUDED — so a deleted record can't be resurrected by the merge,
// and the tombstone propagates to all devices. Re-creating a previously-deleted
// id CLEARS its tombstone (so a re-add wins). Tombstones GC after 90 days. The
// no-data-loss guarantee is intact: only an EXPLICITLY-tombstoned id is dropped;
// an empty/missing/failed server response still never deletes anything.
// ───────────────────────────────────────────────────────────────────────────
//
// The merge functions are PURE (no window, no fetch) so every "no data lost"
// case is unit-testable in the node environment. The orchestration (fetch →
// merge → write-back to BOTH local + server) lives at the bottom and is the
// only part that touches I/O.

import * as dataApi from "./dataApi";
import type { DataSection } from "./dataApi";
import { AuthApiError } from "./authApi";
import {
  loadMeals,
  saveMeals,
  loadWorkouts,
  saveWorkouts,
  loadProfile,
  saveProfile,
} from "./storage";
import {
  loadWeightLog,
  saveWeightLog,
  sanitizeEntries,
  type WeightEntry,
} from "./weightLog";
import {
  loadCoachSettings,
  saveCoachSettings,
  sanitizeCoachSettings,
  type CoachSettings,
} from "./coachSettings";
// chatStore is owned by another agent — we only READ/merge through its public
// load/save/sanitize helpers, never modify the module.
import {
  loadChat,
  saveChat,
  sanitizeHistory,
  type ChatMessage,
} from "./chatStore";
import {
  loadApiTokenData,
  saveApiTokenData,
  sanitizeApiTokenData,
  type ApiTokenData,
} from "./apiTokenStore";
import { isValidGeneratedMealImageDataUrl } from "./image";
import { mealImagePromptText, pruneGeneratedMealImageDataUrls } from "./mealCardImage";
import {
  loadDeletions,
  saveDeletions,
  mergeDeletions,
  tombstonedIds,
  addTombstone,
  type DeletionsMap,
} from "./deletionsStore";
import type { Meal, Profile, Workout } from "./types";

// ─── Pure merge primitives ──────────────────────────────────────────────────
//
// Convention for all of these: `local` is what's on THIS device, `server` is
// what came back from the API. Output is the UNION (no input record dropped).

/** Count the populated (non-undefined, non-null) own keys of an object — a
 *  proxy for "how complete" a record is when two versions collide by id. */
function completeness(o: Record<string, unknown>): number {
  let n = 0;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") n += 1;
  }
  return n;
}

/**
 * Union two id-keyed record arrays. Every id from either side appears once.
 * On an id collision, keep the MORE COMPLETE version (more populated fields),
 * tie-breaking to `local` (the device the user is actively on). This means an
 * enriched record (e.g. a meal that gained nutrition on one device) wins over a
 * sparse duplicate, and nothing is ever dropped.
 */
export function mergeById<T extends { id: string }>(local: T[], server: T[]): T[] {
  const byId = new Map<string, T>();
  // Seed with server first, then let local override on a tie/over-complete —
  // but the completeness check is symmetric, so order only decides exact ties.
  for (const s of server) byId.set(s.id, s);
  for (const l of local) {
    const existing = byId.get(l.id);
    if (!existing) {
      byId.set(l.id, l);
      continue;
    }
    const lc = completeness(l as unknown as Record<string, unknown>);
    const sc = completeness(existing as unknown as Record<string, unknown>);
    // local wins ties (>=) so the active device's edit is preferred.
    byId.set(l.id, lc >= sc ? l : existing);
  }
  return [...byId.values()];
}

/** Merge the meals array (id-keyed). Union — no meal ever lost. */
export function mergeMeals(local: Meal[], server: unknown): Meal[] {
  const s = Array.isArray(server)
    ? (server as Meal[]).filter(isMeal).map(sanitizeServerMealGeneratedImageFields)
    : [];
  const l = local.filter(isMeal).map(sanitizeMealGeneratedImageFields);
  return pruneGeneratedMealImageDataUrls(
    mergeMealsById(l, s).sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  );
}

function mergeMealsById(local: Meal[], server: Meal[]): Meal[] {
  const byId = new Map<string, Meal>();
  for (const s of server) byId.set(s.id, s);
  for (const l of local) {
    const existing = byId.get(l.id);
    if (!existing) {
      byId.set(l.id, l);
      continue;
    }
    const winner = chooseMealConflictWinner(l, existing);
    const loser = winner === l ? existing : l;
    byId.set(
      l.id,
      mergeGeneratedMealImageFields(winner, loser, {
        winnerIsLocal: winner === l,
        loserIsLocal: loser === l,
      }),
    );
  }
  return [...byId.values()];
}

function chooseMealConflictWinner(local: Meal, existing: Meal): Meal {
  const localUpdatedAt = local.updatedAt ?? "";
  const existingUpdatedAt = existing.updatedAt ?? "";
  if (localUpdatedAt || existingUpdatedAt) {
    return localUpdatedAt >= existingUpdatedAt ? local : existing;
  }
  const lc = mealCompleteness(local);
  const sc = mealCompleteness(existing);
  return lc >= sc ? local : existing;
}

const GENERATED_MEAL_IMAGE_KEYS = new Set([
  "generatedImageId",
  "generatedImageDataUrl",
  "generatedImagePrompt",
  "generatedImageDataUrlFailedPrompt",
]);

function mealCompleteness(meal: Meal): number {
  let n = 0;
  for (const [k, v] of Object.entries(meal)) {
    if (GENERATED_MEAL_IMAGE_KEYS.has(k)) continue;
    if (v !== undefined && v !== null && v !== "") n += 1;
  }
  return n;
}

function normalizedMealPrompt(meal: Meal): string {
  return mealImagePromptText(meal);
}

function hasFreshSyncedMealImage(meal: Meal): boolean {
  const prompt = normalizedMealPrompt(meal);
  return Boolean(
    prompt &&
      isValidGeneratedMealImageDataUrl(meal.generatedImageDataUrl) &&
      meal.generatedImagePrompt === prompt,
  );
}

function sanitizeMealGeneratedImageFields(meal: Meal): Meal {
  const out: Meal = { ...meal };
  const prompt = normalizedMealPrompt(out);
  if (
    !isValidGeneratedMealImageDataUrl(out.generatedImageDataUrl) ||
    out.generatedImagePrompt !== prompt
  ) {
    out.generatedImageDataUrl = undefined;
  }
  if (out.generatedImageDataUrlFailedPrompt !== prompt) {
    out.generatedImageDataUrlFailedPrompt = undefined;
  }
  return out;
}

function sanitizeServerMealGeneratedImageFields(meal: Meal): Meal {
  const out = sanitizeMealGeneratedImageFields(meal);
  out.generatedImageId = undefined;
  return out;
}

function hasCurrentGeneratedImageFailure(meal: Meal): boolean {
  const prompt = normalizedMealPrompt(meal);
  return Boolean(prompt && meal.generatedImageDataUrlFailedPrompt === prompt);
}

function samePromptGeneratedImageId(meal: Meal, prompt: string): string | undefined {
  return meal.generatedImagePrompt === prompt ? meal.generatedImageId : undefined;
}

function mergeGeneratedMealImageFields(
  winner: Meal,
  loser: Meal,
  sides: { winnerIsLocal: boolean; loserIsLocal: boolean },
): Meal {
  const out: Meal = { ...winner };
  const prompt = normalizedMealPrompt(out);
  const localSamePromptImageId = sides.winnerIsLocal
    ? samePromptGeneratedImageId(winner, prompt)
    : sides.loserIsLocal
      ? samePromptGeneratedImageId(loser, prompt)
      : undefined;
  if (
    !hasFreshSyncedMealImage(out) &&
    hasFreshSyncedMealImage(loser) &&
    loser.generatedImagePrompt === prompt
  ) {
    out.generatedImageId = localSamePromptImageId;
    out.generatedImageDataUrl = loser.generatedImageDataUrl;
    out.generatedImagePrompt = loser.generatedImagePrompt;
    out.generatedImageDataUrlFailedPrompt = undefined;
  }
  if (localSamePromptImageId) {
    if (!hasFreshSyncedMealImage(out)) out.generatedImageDataUrl = undefined;
    out.generatedImageId = localSamePromptImageId;
    out.generatedImagePrompt = prompt;
  }
  if (!hasFreshSyncedMealImage(out) && hasCurrentGeneratedImageFailure(loser)) {
    out.generatedImageDataUrlFailedPrompt = loser.generatedImageDataUrlFailedPrompt;
  }
  return sanitizeMealGeneratedImageFields(out);
}

function isMeal(v: unknown): v is Meal {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.date === "string" &&
    typeof m.timestamp === "string" &&
    typeof m.type === "string" &&
    typeof m.text === "string"
  );
}

/**
 * Merge the workouts map (keyed by date). Union of date keys; on a SAME-DATE
 * collision the two day documents are themselves UNION-merged BY EXERCISE id, so
 * two devices each adding a DIFFERENT exercise to the same day both survive
 * (previously the whole newer day-document won by updatedAt and the other
 * device's exercise was dropped — Codex review data-loss finding). For a genuine
 * SAME-exercise conflict (same id on both sides) the more complete version wins,
 * tie-breaking to local (the active device), via mergeById. The day's updatedAt
 * becomes the latest of the two so future LWW comparisons stay correct.
 */
export function mergeWorkouts(
  local: Record<string, Workout>,
  server: unknown,
): Record<string, Workout> {
  const s = isWorkoutMap(server) ? server : {};
  const out: Record<string, Workout> = { ...s };
  for (const [date, lw] of Object.entries(local)) {
    const sw = out[date];
    if (!sw) {
      out[date] = lw;
      continue;
    }
    // Union the two day documents by exercise id (no exercise dropped from either
    // side). For a SAME-id conflict, the exercise from the day with the later
    // `updatedAt` wins (a newer correction beats an older one), tie-breaking to
    // local (the active device) — NOT by field-completeness, so a newer edit that
    // simplified an exercise isn't discarded (Codex review). The day's updatedAt
    // becomes the latest of the two.
    const localNewer = (lw.updatedAt ?? "") >= (sw.updatedAt ?? "");
    const winnerDay = localNewer ? lw : sw;
    const loserDay = localNewer ? sw : lw;
    const byId = new Map<string, (typeof winnerDay.exercises)[number]>();
    for (const e of loserDay.exercises ?? []) byId.set(e.id, e);
    for (const e of winnerDay.exercises ?? []) byId.set(e.id, e); // newer day's version wins on id
    out[date] = {
      date,
      exercises: [...byId.values()],
      updatedAt: winnerDay.updatedAt ?? loserDay.updatedAt ?? "",
    };
  }
  return out;
}

function isWorkoutMap(v: unknown): v is Record<string, Workout> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const w of Object.values(v as Record<string, unknown>)) {
    if (!w || typeof w !== "object") return false;
    const ww = w as Record<string, unknown>;
    if (typeof ww.date !== "string" || !Array.isArray(ww.exercises)) return false;
  }
  return true;
}

/**
 * Merge the weight log (one entry per date). Union of dates — no day's weight is
 * ever dropped. On a same-date collision, prefer the LOCAL value (the device the
 * user is on); sanitizeEntries already enforces "last wins" + sort, so we feed
 * server first then local so local overrides a duplicate date.
 */
export function mergeWeightLog(local: WeightEntry[], server: unknown): WeightEntry[] {
  const s = sanitizeEntries(server);
  // server first, local last → on duplicate date, local wins (sanitize: last wins).
  return sanitizeEntries([...s, ...local]);
}

/**
 * Merge the profile (a single object with an ISO `updatedAt`). The NEWER profile
 * wins for ALL fields, with ONE narrow exception: the AVATAR (avatarDataUrl /
 * avatarPhotoId). If the newer side has NO avatar but the older side does, the
 * older avatar is preserved — so a newer non-avatar edit (e.g. a weight change
 * whose payload omits the photo) on one device does NOT wipe the avatar set on
 * another device (Ao's "profile photo doesn't cross devices" report; Codex
 * review: a newer payload lacking the avatar was wiping it).
 *
 * We deliberately scope the backfill to the AVATAR only, NOT to name/weight/etc.:
 * without per-field delete tombstones we cannot distinguish "the user cleared
 * this field" from "this payload simply omitted it", so broadly backfilling would
 * RESURRECT an intentionally-cleared field. The avatar is the reported cross-
 * device gap and a resurrected photo is a far smaller harm than a silently lost
 * one; other fields keep simple newer-wins. (Full delete-sync needs tombstones —
 * a larger change tracked separately; see the module header re: deletes.)
 *
 * A null/absent server profile NEVER wipes a local one (and vice-versa).
 */
export function mergeProfile(local: Profile | null, server: unknown): Profile | null {
  const s = isProfile(server) ? server : null;
  if (!s) return local; // no/invalid server profile → keep local untouched.
  if (!local) return s; // no local → adopt the server's.
  const serverNewer = (s.updatedAt ?? "") > (local.updatedAt ?? "");
  const winner = serverNewer ? s : local;
  const loser = serverNewer ? local : s;
  // Preserve each avatar field INDEPENDENTLY from the loser when the winner lacks
  // THAT field. Grouping them ("has any avatar") was wrong (Codex review): a
  // winner with only the legacy device-local `avatarPhotoId` would block adopting
  // the loser's SYNCED `avatarDataUrl`, losing the cross-device photo. Checked
  // per-field, the synced data-URL is preserved even when a legacy ref is present.
  return {
    ...winner,
    ...(!winner.avatarDataUrl && loser.avatarDataUrl
      ? { avatarDataUrl: loser.avatarDataUrl }
      : {}),
    ...(!winner.avatarPhotoId && loser.avatarPhotoId
      ? { avatarPhotoId: loser.avatarPhotoId }
      : {}),
  };
}

function isProfile(v: unknown): v is Profile {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.heightCm === "number" && typeof p.weightKg === "number";
}

/**
 * Merge coach settings (a small single object, NO updatedAt). Prefer the more
 * complete one, tie-breaking to local. Field-level union so a name set on one
 * device + a style set on another both survive. An empty server object can't
 * clear a configured local persona.
 */
export function mergeCoachSettings(local: CoachSettings, server: unknown): CoachSettings {
  const s = sanitizeCoachSettings(server);
  const l = sanitizeCoachSettings(local);
  // Field-level union: local wins per-field (active device), but a field only
  // present on the server is adopted. Nothing configured anywhere is lost.
  return sanitizeCoachSettings({ ...s, ...l });
}

/**
 * Merge the chat history (id-keyed messages). Union by id, ordered by createdAt
 * so the conversation reads correctly across devices. No message ever dropped.
 */
export function mergeChat(local: ChatMessage[], server: unknown): ChatMessage[] {
  const s = sanitizeHistory(server);
  const l = sanitizeHistory(local);
  return mergeById(l, s).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Merge the access-key envelope ({ token, updatedAt }). Like mergeProfile this is
 * a single object with an ISO `updatedAt`: the NEWER side wins, EXCEPT a blank
 * token can never overwrite a non-empty one (the whole point of the durable key
 * is that a delete/re-add — which starts from an empty local — RESTORES the key
 * from the server, never erases the server's). Concretely:
 *   - server token empty  → keep local untouched (an empty server can't clear it).
 *   - local token empty   → adopt the server's key (the restore path).
 *   - both non-empty      → the newer updatedAt wins (a genuine key change on the
 *                            most-recently-used device propagates).
 * This means the real "device wipe → re-add → login" flow (empty local, populated
 * server) always restores the key, and a stale/empty push can never wipe it.
 */
export function mergeApiToken(local: ApiTokenData, server: unknown): ApiTokenData {
  const l = sanitizeApiTokenData(local);
  const s = sanitizeApiTokenData(server);
  if (!s.token) return l; // empty server → never clears a local key.
  if (!l.token) return s; // empty local (fresh/wiped device) → RESTORE from server.
  // Both present → newer change wins; tie / missing timestamps → keep local
  // (the active device), mirroring mergeProfile's bias.
  return (s.updatedAt ?? "") > (l.updatedAt ?? "") ? s : l;
}

// ─── Tombstone application ───────────────────────────────────────────────────
//
// After a section's UNION merge, drop any record whose id is tombstoned in the
// (already-merged) deletions map. This is what makes a delete STICK: the union
// re-adds the deleted record from the other side, then this removes it again.
// Applied for the id-keyed sections only; profile/coachSettings/apiToken have no
// per-record id (their "delete" is just an empty value carried by newer-wins).

/** Return `value` with any tombstoned id removed, for the given section. Pure.
 *  Shapes per section: meals/chat = arrays of {id}; workouts = map date→{exercises:[{id}]}
 *  (exercise-level tombstones); weightLog = array of {date} (id === date). */
export function applyTombstonesToSection(
  section: DataSection,
  value: unknown,
  deletions: DeletionsMap,
): unknown {
  const dead = tombstonedIds(deletions, section);
  if (dead.size === 0) return value;

  if (section === "meals" || section === "chat") {
    if (!Array.isArray(value)) return value;
    return value.filter((it) => {
      const id = (it as { id?: unknown })?.id;
      return !(typeof id === "string" && dead.has(id));
    });
  }
  if (section === "weightLog") {
    // weightLog records are keyed by `date`; the tombstone id IS the date.
    if (!Array.isArray(value)) return value;
    return value.filter((it) => {
      const d = (it as { date?: unknown })?.date;
      return !(typeof d === "string" && dead.has(d));
    });
  }
  if (section === "workouts") {
    // Exercise-level tombstones: id = exercise id. Drop tombstoned exercises from
    // each day; a day left with no exercises is itself dropped (an emptied day is
    // a deleted day, not an empty record to resurrect).
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [date, day] of Object.entries(value as Record<string, unknown>)) {
      const exs = (day as { exercises?: unknown })?.exercises;
      if (!Array.isArray(exs)) {
        out[date] = day;
        continue;
      }
      const keptExs = exs.filter((e) => {
        const id = (e as { id?: unknown })?.id;
        return !(typeof id === "string" && dead.has(id));
      });
      if (keptExs.length > 0) {
        out[date] = { ...(day as object), exercises: keptExs };
      }
      // else: every exercise tombstoned → the day is gone (not re-added empty).
    }
    return out;
  }
  return value;
}

// ─── Same-document change notification ───────────────────────────────────────
//
// The browser `storage` event ONLY fires in OTHER documents/tabs — a write from
// THIS document (e.g. mergeOnLogin's writeLocal right after login) does NOT
// notify already-mounted components in the SAME tab. Consumers therefore listen
// for `storage` + `focus`, which leaves the post-login view stale until a manual
// reload / refocus. We bridge that gap with a same-document CustomEvent: every
// programmatic localStorage write performed by THIS module dispatches it, and
// every consumer that re-reads on `storage`/`focus` also listens for it, so
// login → mergeOnLogin → writeLocal → refresh repaints with NO reload.

/** Same-document data-change signal. `detail.section` names the section written
 *  (consumers may ignore it and just re-read everything — they currently do). */
export const DATA_CHANGED_EVENT = "health-app:data-changed";

/** Fire the same-document data-changed signal for one section. SSR-safe (no-op
 *  when window is absent) and never throws (a notify failure must not break a
 *  successful local write). */
function notifyDataChanged(section: DataSection): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(DATA_CHANGED_EVENT, { detail: { section } }),
    );
  } catch {
    // Older/edge environments without CustomEvent: a missed in-tab refresh just
    // falls back to the existing focus/storage path — never a hard failure.
  }
}

/**
 * USER-VISIBLE SYNC FAILURE signal. Most push failures are TRANSIENT (offline,
 * 5xx, a logout race) and are retried silently — surfacing those would be noise.
 * But a NON-retryable server REJECTION (HTTP 400 — e.g. the section blob exceeds
 * the server's size cap) fails identically on every retry: the save is NOT
 * reaching the server, so the user MUST be told (silently dropping it is exactly
 * the "meals don't sync" bug). A small toast (SyncErrorToast) listens for this.
 * The local copy is always intact — this only reports that a save didn't sync.
 */
export const SYNC_ERROR_EVENT = "health-app:sync-error";

export interface SyncErrorDetail {
  section: DataSection;
}

/** Fire the user-visible sync-failure signal. SSR-safe + never throws (a notify
 *  failure must not break the surrounding push). */
function notifySyncError(detail: SyncErrorDetail): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(SYNC_ERROR_EVENT, { detail }));
  } catch {
    // CustomEvent unavailable (old/edge env): the failure just isn't surfaced —
    // never a hard throw into the push path.
  }
}

/**
 * Is a PUT rejection TERMINAL (the same blob will be rejected again, so retrying
 * is pointless and the user should be told)? A server 400 — validation / size cap
 * (MAX_DATA_BLOB_BYTES) — is terminal. A network failure (fetch threw a TypeError:
 * no `status`), a 5xx, or a session/rate transient (401/403/429) is NOT terminal:
 * the caller retries those silently as before. Exported pure for unit tests.
 */
export function isTerminalPutRejection(err: unknown): boolean {
  return err instanceof AuthApiError && err.status === 400;
}

// ─── Orchestration (I/O) ─────────────────────────────────────────────────────

/** One section's wiring: read local, merge with a server blob, write merged
 *  back to local. Returns the merged value to push to the server. */
interface SectionPlan<T> {
  section: DataSection;
  /** Read this device's current value. */
  readLocal: () => T;
  /** Pure merge of (local, serverBlob). */
  merge: (local: T, server: unknown) => T;
  /** Write the merged value to local (only ADDS — never the empty wipe path). */
  writeLocal: (merged: T) => void;
}

const SECTION_PLANS: SectionPlan<unknown>[] = [
  // `deletions` is FIRST so the tombstone map is merged BEFORE the id-keyed
  // sections that read it (applyTombstonesToSection uses the freshest local map,
  // which this plan has already updated to the cross-device union).
  {
    section: "deletions",
    readLocal: () => loadDeletions(),
    merge: (l, s) => mergeDeletions(l, s),
    writeLocal: (m) => saveDeletions(m as DeletionsMap),
  },
  {
    section: "profile",
    readLocal: () => loadProfile(),
    merge: (l, s) => mergeProfile(l as Profile | null, s),
    writeLocal: (m) => {
      if (m) saveProfile(m as Profile);
    },
  },
  {
    section: "meals",
    readLocal: () => loadMeals(),
    merge: (l, s) => mergeMeals(l as Meal[], s),
    writeLocal: (m) => saveMeals(m as Meal[]),
  },
  {
    section: "workouts",
    readLocal: () => loadWorkouts(),
    merge: (l, s) => mergeWorkouts(l as Record<string, Workout>, s),
    writeLocal: (m) => saveWorkouts(m as Record<string, Workout>),
  },
  {
    section: "weightLog",
    readLocal: () => loadWeightLog(),
    merge: (l, s) => mergeWeightLog(l as WeightEntry[], s),
    writeLocal: (m) => saveWeightLog(m as WeightEntry[]),
  },
  {
    section: "coachSettings",
    readLocal: () => loadCoachSettings(),
    merge: (l, s) => mergeCoachSettings(l as CoachSettings, s),
    writeLocal: (m) => saveCoachSettings(m as CoachSettings),
  },
  {
    section: "chat",
    readLocal: () => loadChat(),
    merge: (l, s) => mergeChat(l as ChatMessage[], s),
    writeLocal: (m) => saveChat(m as ChatMessage[]),
  },
  {
    section: "apiToken",
    readLocal: () => loadApiTokenData(),
    merge: (l, s) => mergeApiToken(l as ApiTokenData, s),
    writeLocal: (m) => saveApiTokenData(m as ApiTokenData),
  },
];

/** Most server PUTs accept an object or array — but coachSettings/profile can be
 *  empty objects and the server still accepts `{}`. Only chat/meals/etc. as []
 *  arrays. The server rejects scalars/null, so we skip a PUT when the merged
 *  value is null (no profile to store yet). */
function isPushable(value: unknown): boolean {
  return value !== null && value !== undefined && typeof value === "object";
}

export interface SyncDeps {
  csrfToken: string | null;
  fetchImpl?: typeof fetch;
  /** Hook for tests / telemetry; never throws into the caller. */
  onError?: (section: DataSection, err: unknown) => void;
  /**
   * STALE-SESSION GUARD (privacy). Returns true when this merge no longer belongs
   * to the active auth session — e.g. the user logged out or switched accounts
   * WHILE this (async, per-section) merge was in flight. When it returns true,
   * mergeOnLogin must STOP: it must NOT write the (now previous-user) server data
   * back into the just-cleared localStorage, must NOT re-open the push gate, and
   * must NOT push. Without this, a slow A-login merge could resume after a logout
   * / A→B switch and repopulate A's data into local — a cross-account leak. The
   * caller (AuthProvider) wires this to its effect-cancellation flag.
   */
  isCancelled?: () => boolean;
  /**
   * SYNCHRONOUS gate check (privacy, live-pull only). Returns true when the sync
   * gate has closed (logout / account switch flipped setSyncCsrfToken to null).
   * Unlike `isCancelled` (a React effect flag that flips only on cleanup, which
   * on logout runs AFTER the awaited clearAllLocalData), the module token is
   * cleared SYNCHRONOUSLY at logout — so refreshFromServer passes this to stop an
   * in-flight pull from writing the logged-out user's data back into a cleared
   * local during that cleanup window (Codex review finding). mergeOnLogin does not
   * set it.
   */
  isGateClosed?: () => boolean;
}

function sectionItemCount(section: DataSection, value: unknown): number {
  if (section === "meals") return Array.isArray(value) ? value.length : 0;
  if (section === "workouts") {
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>).length
      : 0;
  }
  if (section === "weightLog") return Array.isArray(value) ? value.length : 0;
  if (section === "chat") return Array.isArray(value) ? value.length : 0;
  // Single-object settings: treat configured/non-empty as one item.
  if (section === "profile" || section === "coachSettings") {
    return value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0
      ? 1
      : 0;
  }
  // Access key: "configured" means a NON-EMPTY token (the envelope always exists,
  // even when blank). Counting only a real token means a restore (empty→key)
  // grows 0→1 (never tripping the shrink-guard) while a blank push stays 0.
  if (section === "apiToken") {
    return value &&
      typeof value === "object" &&
      typeof (value as { token?: unknown }).token === "string" &&
      ((value as { token: string }).token.trim().length > 0)
      ? 1
      : 0;
  }
  return 0;
}

/**
 * Last-resort fuse: login sync must never write a smaller local section than the
 * one that existed before the merge. Pure merge rules already union, but this
 * catches future sanitizer/schema mistakes before they become a visible wipe.
 */
export function wouldShrinkSection(section: DataSection, before: unknown, after: unknown): boolean {
  return sectionItemCount(section, after) < sectionItemCount(section, before);
}

/** Per-section summary entry shared by the login merge and the live refresh. */
interface SectionSyncResult {
  merged: boolean;
  pushed: boolean;
  error?: string;
}

/**
 * Sync ONE section: GET the server blob → UNION-merge into local → write local
 * (+ notify) → mark merged → push the union back. Shared by mergeOnLogin (the
 * once-per-login restore) and refreshFromServer (the live cross-device pull) so
 * BOTH paths carry the identical no-data-loss guarantees (union-only merge,
 * shrink-guard, stale-session guard, local-first). All errors are isolated to
 * the returned entry; this never throws into the caller.
 */
async function syncSection(plan: SectionPlan<unknown>, deps: SyncDeps): Promise<SectionSyncResult> {
  const entry: SectionSyncResult = { merged: false, pushed: false };

  // STALE-SESSION GUARD: bail if the session ended (logout / account switch)
  // before we even start — never begin restoring another user's data into a
  // just-cleared local.
  if (deps.isCancelled?.() || deps.isGateClosed?.()) {
    entry.error = "cancelled";
    return entry;
  }

  let serverBlob: unknown;
  try {
    const res = await dataApi.getData(plan.section, { fetchImpl: deps.fetchImpl });
    serverBlob = res.data; // null when the user has no row yet (a real, safe "empty").
  } catch (err) {
    // GUARD: server unknown → DO NOT TOUCH LOCAL. Skip; retry next time.
    entry.error = err instanceof Error ? err.message : "fetch_failed";
    deps.onError?.(plan.section, err);
    return entry;
  }

  // STALE-SESSION GUARD: the await above yielded — if the session ended while the
  // GET was in flight, the server data we just fetched belongs to a user who has
  // since logged out / been switched away. Writing it now would repopulate a
  // cleared local with a previous user's data (the cross-account leak). Stop.
  // We ALSO honor a caller-supplied synchronous gate (`isGateClosed`) so the LIVE
  // PULL can additionally stop the instant logout flips the module token
  // (setSyncCsrfToken null) — which happens BEFORE the React cleanup flips
  // `cancelled` (Codex review: logout-cleanup-ordering window). mergeOnLogin does
  // not pass it (it runs right after the token is set), so its many direct-call
  // tests are unaffected.
  if (deps.isCancelled?.() || deps.isGateClosed?.()) {
    entry.error = "cancelled";
    return entry;
  }

  // Merge is a UNION — even a null serverBlob just yields local unchanged.
  const local = plan.readLocal();
  const union = plan.merge(local, serverBlob);
  // TOMBSTONE EXCLUSION: drop ids the user deleted (on this or another device).
  // `deletions` is synced FIRST, so loadDeletions() now holds the cross-device
  // tombstone union. We compare the shrink-guard against the tombstone-applied
  // LOCAL baseline too, so a legitimate cross-device DELETE (which makes the
  // result smaller than raw-local) is NOT mistaken for a wipe. `deletions` itself
  // is never tombstone-filtered.
  const deletions = plan.section === "deletions" ? ({} as DeletionsMap) : loadDeletions();
  const merged = applyTombstonesToSection(plan.section, union, deletions);
  const localBaseline = applyTombstonesToSection(plan.section, local, deletions);
  if (wouldShrinkSection(plan.section, localBaseline, merged)) {
    entry.error = "shrink_guard_blocked";
    deps.onError?.(plan.section, new Error("shrink_guard_blocked"));
    return entry;
  }
  // local-first: persist the safe union immediately. Suppress the save-triggered
  // push (we push the union explicitly below) so the write can't recurse into
  // pushSectionBestEffort → reconcile → writeLocal → push …
  withPushSuppressed(() => plan.writeLocal(merged));
  // Same-document write: tell already-mounted components to re-read NOW (the
  // browser `storage` event won't fire in this tab), so the just-restored/pulled
  // data paints without a manual reload/refocus.
  notifyDataChanged(plan.section);
  entry.merged = true;
  // Restore/pull complete for this section → background pushes may now resume
  // safely (local now holds the server's data, so a push can no longer wipe it).
  mergedSections.add(plan.section);

  // Push the merged result back so the server reflects the union too. Skip if the
  // session ended during this iteration (the csrf is stale anyway, but we also
  // avoid an unnecessary post-logout request).
  if (isPushable(merged) && !deps.isCancelled?.() && !deps.isGateClosed?.()) {
    try {
      await dataApi.putData(plan.section, merged, deps.csrfToken, {
        fetchImpl: deps.fetchImpl,
      });
      entry.pushed = true;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : "push_failed";
      deps.onError?.(plan.section, err);
      // Local already holds the merged data; the next write/login retries the push.
    }
  }

  return entry;
}

/**
 * LOGIN MERGE — run once when the user becomes authed. For each section:
 *   1. GET the server blob. If the GET THROWS (offline / 5xx / 401) we SKIP that
 *      section entirely — local stays exactly as-is (the #1 rule: a failed/empty
 *      server response must never delete local data).
 *   2. Merge (UNION) server into local.
 *   3. Write the merged result to BOTH local and the server.
 *
 * Best-effort + isolated per section: one section failing never aborts the
 * others, and never throws into the React layer. Returns a per-section summary
 * for diagnostics.
 */
export async function mergeOnLogin(deps: SyncDeps): Promise<
  Record<string, SectionSyncResult>
> {
  const summary: Record<string, SectionSyncResult> = {};

  // Login sync must be ON: without it, the installed app / browser / family devices
  // each show only their own localStorage and records look "gone". The protection is
  // not to disable sync, but to refuse any local write that would shrink a section.
  // 2026-06-22: enabled after HARD verification of the no-data-loss path (union-only
  // merge + shrink-guard + wipe-fuse + local-first, proven by syncData.mergeOnLogin
  // tests + a real 2-device auth round-trip). Kept as an INSTANT rollback switch:
  // flip to false to disable cross-device sync without any other change.
  const SYNC_ENABLED: boolean = true;
  if (!SYNC_ENABLED) return summary;

  // Capture the session generation at the start. If a caller supplied its own
  // synchronous gate (AuthProvider passes !syncEnabled()), combine it with a
  // generation check so an A→B switch that re-opens the value gate mid-merge still
  // aborts A's in-flight restore (defense-in-depth alongside the caller's
  // per-effect `isCancelled`). Direct test callers that pass neither are
  // unaffected — generation only changes on a setSyncCsrfToken call.
  const generation = currentSyncGeneration();
  const callerGate = deps.isGateClosed;
  const depsGen: SyncDeps = {
    ...deps,
    isGateClosed: () =>
      currentSyncGeneration() !== generation || (callerGate ? callerGate() : false),
  };

  for (const plan of SECTION_PLANS) {
    summary[plan.section] = await syncSection(plan, depsGen);
  }

  return summary;
}

/**
 * LIVE CROSS-DEVICE REFRESH — pull the server's latest into an ALREADY-authed,
 * still-open session so a change made on ANOTHER device appears without a reload
 * or re-login. This is the missing half of cross-device sync: writes already
 * push up on save, but an open tab never re-pulled. The AuthProvider wires this
 * to `focus` / `visibilitychange→visible` and a slow interval.
 *
 * It is the SAME per-section union as mergeOnLogin (GET → union-merge → write
 * local + notify → push the union back), so it carries identical no-data-loss
 * guarantees: a refresh can only ADD records to local (never drop a local edit),
 * a failed/empty GET leaves local untouched, the shrink-guard still fires, and
 * the stale-session guard blocks a write after a logout/account-switch.
 *
 * Callers MUST only invoke this when sync is enabled (an authed session); it is a
 * no-op otherwise so a logged-out interval/focus can never pull another user's
 * data. Best-effort + never throws.
 */
export async function refreshFromServer(deps: SyncDeps): Promise<
  Record<string, SectionSyncResult>
> {
  const summary: Record<string, SectionSyncResult> = {};
  // Only ever pull for an authed session (defense-in-depth alongside the caller's
  // own guard): no csrf / logged out → do nothing.
  if (!syncEnabled() || deps.isCancelled?.()) return summary;

  // Capture the session generation and pass a SYNCHRONOUS, generation-aware gate
  // so each per-section write aborts the instant a logout/account-switch crosses a
  // session boundary — even if a NEW session (A→B) re-opens the value gate while
  // this pull is mid-flight. Logout flips setSyncCsrfToken(null) synchronously,
  // before the React effect's `cancelled` flips on cleanup; the generation closes
  // both that window and the A→B re-open race (Codex review findings).
  const generation = currentSyncGeneration();
  const gateClosed = () => currentSyncGeneration() !== generation || !syncEnabled();
  const depsWithGate: SyncDeps = { ...deps, isGateClosed: gateClosed };

  for (const plan of SECTION_PLANS) {
    if (deps.isCancelled?.() || gateClosed()) {
      summary[plan.section] = { merged: false, pushed: false, error: "cancelled" };
      continue;
    }
    summary[plan.section] = await syncSection(plan, depsWithGate);
  }

  return summary;
}

// ─── Manual export / import (interim offline safety net) ─────────────────────
//
// A user can download EVERY section as one JSON file and re-import it on any
// device/browser — a self-serve backup that works fully offline (no server,
// no login). Import MERGES (the same UNION rules) so re-importing can only ADD
// records, never wipe what's already on the device. This is the belt-and-braces
// guard against the original data-loss: even with no network, the user holds a
// copy.

/** The full export envelope. Versioned so a future format change is detectable. */
export interface DataExport {
  app: "health-app";
  version: 1;
  exportedAt: string;
  sections: Record<string, unknown>;
}

/** Snapshot ALL sections from local into a single export object. Pure-ish
 *  (reads localStorage via the section plans; SSR-safe — empty on the server). */
export function buildExport(): DataExport {
  const sections: Record<string, unknown> = {};
  for (const plan of SECTION_PLANS) {
    if (plan.section === "apiToken") continue;
    sections[plan.section] = plan.readLocal();
  }
  return {
    app: "health-app",
    version: 1,
    exportedAt: new Date().toISOString(),
    sections,
  };
}

/** Serialize the current local data to a pretty JSON string for download. */
export function exportToJson(): string {
  return JSON.stringify(buildExport(), null, 2);
}

export interface ImportResult {
  ok: boolean;
  /** Sections that were merged in. */
  merged: DataSection[];
  /** Human-readable reason when ok === false. */
  reason?: string;
}

/**
 * Parse + MERGE an exported JSON string into local storage. Every section is
 * UNION-merged with what's already on the device (never overwritten), so an
 * import can only ADD records — re-importing an old backup can't delete newer
 * local data. Unknown sections are ignored; a malformed/foreign file is rejected
 * without touching local. Pure-ish (writes localStorage via the section plans).
 */
export function importFromJson(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, merged: [], reason: "ファイルを読み取れませんでした（JSONではありません）" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, merged: [], reason: "ファイルの形式が正しくありません" };
  }
  const env = parsed as Partial<DataExport> & { sections?: unknown };
  const incoming =
    env.sections && typeof env.sections === "object"
      ? (env.sections as Record<string, unknown>)
      : // Tolerate a bare {section: data} object too (lenient import).
        (parsed as Record<string, unknown>);

  const merged: DataSection[] = [];
  for (const plan of SECTION_PLANS) {
    if (plan.section === "apiToken") continue;
    if (!(plan.section in incoming)) continue;
    const local = plan.readLocal();
    const union = plan.merge(local, incoming[plan.section]);
    // Apply tombstones so an imported backup can't resurrect a record the user
    // has since deleted (deletions is processed first, so loadDeletions() holds
    // the merged map). deletions itself is never tombstone-filtered.
    const deletions = plan.section === "deletions" ? ({} as DeletionsMap) : loadDeletions();
    const next = applyTombstonesToSection(plan.section, union, deletions);
    // UNION — only adds; never the empty-wipe path. Suppress the save-triggered
    // push (we push explicitly below) so the write can't recurse.
    withPushSuppressed(() => plan.writeLocal(next));
    // Same-document write (import is a manual on-page action): repaint without a
    // reload, exactly like the login restore path.
    notifyDataChanged(plan.section);
    merged.push(plan.section);
    // Re-push the enriched local to the server too (best-effort, reconciles).
    pushSectionBestEffort(plan.section);
  }
  if (merged.length === 0) {
    return { ok: false, merged: [], reason: "取り込めるデータが見つかりませんでした" };
  }
  return { ok: true, merged };
}

// ─── Best-effort per-section push (for ongoing writes) ───────────────────────
//
// After the login merge, every local write should also reach the server so a
// later device wipe loses nothing. storage.ts calls pushSectionBestEffort after
// each save. It is FIRE-AND-FORGET with a small retry, and NEVER throws — a
// failed push leaves local intact (local is always the source of truth until a
// successful server save, never the other way round).

/** Module-scoped csrf token, set by the auth layer once known. A push without it
 *  will 403; we still attempt (the server may accept via origin) and retry. */
let currentCsrfToken: string | null = null;

/**
 * Sections whose LOGIN MERGE (restore) has completed this session — the
 * EMPTY-LOCAL-BEFORE-RESTORE wipe fuse.
 *
 * THE WIPE THIS GUARDS AGAINST (the real "data消えた after the sync deploy"):
 * at login the auth layer enables sync (setSyncCsrfToken) and THEN fires the
 * async mergeOnLogin. On a fresh device / incognito, local is EMPTY and the
 * restore only lands AFTER a server round-trip. In that gap, any background push
 * (a save, the visibility/pagehide flush, the 2-min interval) would read the
 * still-empty local and PUT `[]` over the populated server — overwriting the
 * family's data with empty. mergeById/wouldShrinkSection can't catch this: it's
 * a raw push, not a merge.
 *
 * The fix: a section may NOT be pushed in the background until its login-merge
 * has run to completion (restoring the server's data into local first). Until
 * then pushSectionBestEffort is a no-op for that section, so an empty local can
 * never reach the server before the restore. A section whose GET FAILED this
 * session is intentionally NOT marked merged (we don't know the server, so we
 * keep local untouched AND refuse to push over it until a future successful
 * merge). Reset on every (re)login so a new session re-gates correctly.
 */
const mergedSections = new Set<DataSection>();

/**
 * SYNC SESSION GENERATION. Incremented on EVERY setSyncCsrfToken call (login,
 * logout, A→B switch). A long-running async op (a login merge, a live refresh, or
 * a background merge-push) captures the generation at its start and aborts if the
 * generation has since changed — i.e. ANY session boundary crossed while it was in
 * flight. This is stronger than the value-based gate (syncEnabled/sectionMergeReady):
 * on an A→B switch the token + merge-ready flags can RE-OPEN for B, fooling a value
 * check into letting a STALE A operation resume and write A's data into B's local
 * (Codex review). Generation equality can never be fooled that way — B's login
 * bumped the generation, so A's captured generation no longer matches. */
let syncGeneration = 0;

/** The current sync session generation (captured by long-running async sync ops). */
export function currentSyncGeneration(): number {
  return syncGeneration;
}

/** Called by the auth layer when the session/csrf is known (and on logout=null).
 *  When `null`, ongoing background pushes are disabled (logged-out / no session).
 *  Setting a token RE-GATES pushes: nothing is pushed until mergeOnLogin restores
 *  each section (so an empty fresh device can't push over the server first). */
export function setSyncCsrfToken(token: string | null): void {
  currentCsrfToken = token;
  // Any csrf change = a new sync session: bump the generation so any in-flight op
  // from the previous session aborts, and require a fresh login-merge before
  // background pushes resume (prevents the empty-before-restore wipe).
  syncGeneration += 1;
  mergedSections.clear();
}

/** Whether background pushes are currently enabled (a session csrf is present). */
export function syncEnabled(): boolean {
  return currentCsrfToken !== null;
}

/** The live session CSRF token (set by the auth layer), or null when logged out.
 *  Read by features outside the AuthProvider tree (e.g. the chat coach's calendar
 *  plan POST) that need to send X-CSRF-Token without prop-drilling the token. */
export function getSyncCsrfToken(): string | null {
  return currentCsrfToken;
}

/**
 * PUSH SUPPRESSION (re-entrancy guard). The section save helpers (saveMeals,
 * saveProfile, …) intentionally call pushSectionBestEffort on every write so a
 * user edit reaches the server. But the SYNC layer itself writes local through
 * those SAME helpers (mergeOnLogin / refreshFromServer / reconcileForPush write
 * the merged union back to local). Without a guard, that sync-internal write
 * would re-trigger pushSectionBestEffort → attemptPush → reconcileForPush →
 * writeLocal → push → … an unbounded self-triggering push loop / network storm.
 *
 * We wrap every sync-internal local write in `withPushSuppressed`, and
 * pushSectionBestEffort no-ops while suppressed. The sync layer pushes the merged
 * value EXPLICITLY (via dataApi.putData), so suppressing the write-triggered push
 * loses nothing — it only removes the redundant, recursive one. A genuine user
 * edit (outside this guard) still pushes exactly once. The counter is sync (no
 * await inside a suppressed region) so it can never strand the flag "on".
 */
let pushSuppressionDepth = 0;
function withPushSuppressed(fn: () => void): void {
  pushSuppressionDepth += 1;
  try {
    fn();
  } finally {
    pushSuppressionDepth -= 1;
  }
}

/** True once `section`'s login-merge (restore) has completed this session, so a
 *  background push of that section can no longer overwrite the server with an
 *  un-restored (e.g. empty fresh-device) local value. Exported for tests. */
export function sectionMergeReady(section: DataSection): boolean {
  return mergedSections.has(section);
}

const RETRY_DELAYS_MS = [1000, 4000, 15000];

/**
 * Push one section's CURRENT local value to the server, best-effort with retry.
 * Reads the freshest local value via the section plan (so a burst of writes
 * coalesces on the latest state). Never throws. No-op when sync is disabled
 * (logged out) or window is absent (SSR).
 */
export function pushSectionBestEffort(section: DataSection): void {
  if (typeof window === "undefined") return;
  // RE-ENTRANCY GUARD: a write performed BY the sync layer (merge/refresh/
  // reconcile writing the union back to local) must not re-trigger a push — that
  // would recurse (push → reconcile → writeLocal → push → …). The sync layer
  // pushes the merged value explicitly, so suppress the write-triggered one.
  if (pushSuppressionDepth > 0) return;
  if (!syncEnabled()) return; // not authed → local-only, exactly as before.
  // WIPE FUSE: do not push until this section's login-merge has restored local.
  // On a fresh/empty device this stops an empty local from over-writing the
  // server's data in the gap before mergeOnLogin lands (the real data-loss path).
  if (!sectionMergeReady(section)) return;
  const plan = SECTION_PLANS.find((p) => p.section === section);
  if (!plan) return;

  void attemptPush(plan, 0);
}

/**
 * Record a cross-device DELETE for an id-keyed record: write the tombstone, then
 * push BOTH the `deletions` blob (so other devices learn of the delete) and the
 * affected `section` (so the server's copy drops the item via reconcileForPush's
 * tombstone exclusion). Call this from the delete handlers AFTER removing the
 * record from local. SSR-safe + never throws. The local removal itself is done by
 * the caller's save (the tombstone just makes the delete STICK across the union).
 */
export function recordDeletion(section: DataSection, id: string): void {
  if (typeof window === "undefined") return;
  if (!id) return;
  addTombstone(section, id);
  // Tell consumers the deletions map changed (harmless; sections already repaint
  // off their own save), then propagate: push the tombstone set + the section.
  notifyDataChanged("deletions");
  pushSectionBestEffort("deletions");
  pushSectionBestEffort(section);
}

/** Record deletes for MANY ids in one section (bulk remove / day clear). */
export function recordDeletions(section: DataSection, ids: Iterable<string>): void {
  if (typeof window === "undefined") return;
  let any = false;
  for (const id of ids) {
    if (id) {
      addTombstone(section, id);
      any = true;
    }
  }
  if (!any) return;
  notifyDataChanged("deletions");
  pushSectionBestEffort("deletions");
  pushSectionBestEffort(section);
}

/** Result of reconcileForPush: `ok` false means the server could not be read
 *  (the caller MUST defer rather than PUT a clobbering value); `value` is the
 *  union to PUT when ok. Exported for deterministic, awaitable testing of the
 *  no-clobber MERGE step that attemptPush runs as fire-and-forget. */
export interface ReconcileResult {
  ok: boolean;
  value: unknown;
}

/**
 * The no-clobber MERGE step of a background push: GET the server's CURRENT value
 * for `section`, UNION-merge it with local (the same no-data-loss merge as the
 * login/refresh path), write the union back to local (so this device also gains
 * any record the OTHER device added concurrently), and return the union to PUT.
 *
 * WHY: a routine save used to PUT this device's local list VERBATIM. If the other
 * device added a record since this device last synced, that raw PUT overwrote the
 * server with a list missing it — an effective last-writer-wins data loss (the
 * "A・Bで別々に追加→片方が消える" case). Reconciling before the PUT makes concurrent
 * adds from BOTH devices survive; the union can only ADD, so the PUT never drops a
 * server record.
 *
 * On a GET FAILURE this returns { ok: false } and DOES NOT touch local — the
 * caller must DEFER (retry later), never fall back to a clobbering raw PUT.
 */
export async function reconcileForPush(
  section: DataSection,
  opts?: FetchOptionLite,
): Promise<ReconcileResult> {
  const plan = SECTION_PLANS.find((p) => p.section === section);
  if (!plan) return { ok: false, value: null };
  let serverBlob: unknown;
  try {
    const res = await dataApi.getData(section, opts);
    serverBlob = res.data;
  } catch {
    return { ok: false, value: null }; // couldn't read → caller defers, no clobber.
  }
  // PRIVACY GATE (post-GET): the GET awaited — if the session ended meanwhile
  // (logout / account switch flips setSyncCsrfToken null), do NOT write the
  // fetched (previous-user) server data into the just-cleared local. The caller
  // (attemptPush) passes the gate; a direct test call leaves it open.
  if (opts?.isGateClosed?.()) {
    return { ok: false, value: null };
  }
  const local = plan.readLocal();
  const union = plan.merge(local, serverBlob);
  // TOMBSTONE EXCLUSION: a record the user DELETED (locally — e.g. this very save
  // is a delete — or on another device) must NOT be resurrected by the union and
  // then pushed back. Apply the merged tombstone map to the union before the PUT.
  // `deletions` itself is never filtered. The shrink-guard compares against the
  // tombstone-APPLIED local + server, so a legitimate delete (which makes the
  // result smaller than the raw server blob that still holds the item) is NOT
  // treated as a clobber.
  const deletions = plan.section === "deletions" ? ({} as DeletionsMap) : loadDeletions();
  const merged = applyTombstonesToSection(plan.section, union, deletions);
  const localBaseline = applyTombstonesToSection(plan.section, local, deletions);
  const serverBaseline = applyTombstonesToSection(plan.section, serverBlob, deletions);
  if (
    wouldShrinkSection(plan.section, localBaseline, merged) ||
    wouldShrinkSection(plan.section, serverBaseline, merged)
  ) {
    return { ok: false, value: null };
  }
  // Persist the (tombstone-applied) union locally first and repaint. Suppress the
  // save-triggered push: attemptPush pushes `merged` explicitly, so re-triggering
  // a push here would recurse.
  withPushSuppressed(() => plan.writeLocal(merged));
  notifyDataChanged(plan.section);
  return { ok: true, value: merged };
}

/** Minimal fetch-injection option (mirrors dataApi.FetchOption) so tests can
 *  drive reconcileForPush against a fake server without the global fetch. The
 *  optional `isGateClosed` is the synchronous privacy gate (see SyncDeps): when it
 *  returns true after the GET, reconcileForPush defers without writing local. */
interface FetchOptionLite {
  fetchImpl?: typeof fetch;
  isGateClosed?: () => boolean;
}

async function attemptPush(plan: SectionPlan<unknown>, attempt: number): Promise<void> {
  // Re-check the gate on EVERY attempt (incl. scheduled retries), not just at
  // pushSectionBestEffort time. An account switch / logout between the initial
  // call and a retry flips syncEnabled()/sectionMergeReady() — without this a
  // queued retry could read the (now previous-user or cleared) local and PUT it.
  if (typeof window === "undefined") return;
  if (!syncEnabled()) return; // logged out / gate closed during the switch.
  if (!sectionMergeReady(plan.section)) return; // this user's merge hasn't restored yet.
  const value = plan.readLocal();
  if (!isPushable(value)) return; // nothing to store (e.g. no profile yet).

  // SESSION-IDENTITY CAPTURE (privacy). Capture the generation + token NOW. The
  // A→B switch race: a stale A push awaits the reconcile GET, then B fully logs in
  // (token + sectionMergeReady RE-OPEN for B) — a value-only gate would let A's
  // stale reconcile resume and write A's server data into B's local + PUT it. The
  // generation can't be fooled: B's login bumped it, so `generation` no longer
  // matches and we abort. We also PUT with the CAPTURED token, never the live one.
  const generation = currentSyncGeneration();
  const csrfToken = currentCsrfToken;
  const gateClosed = () =>
    currentSyncGeneration() !== generation ||
    !syncEnabled() ||
    !sectionMergeReady(plan.section);

  const retry = () => {
    if (attempt + 1 < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt];
      setTimeout(() => void attemptPush(plan, attempt + 1), delay);
    }
    // Out of retries → give up silently. Local is intact; the next write or the
    // next login merge / refresh will reconcile. We NEVER surface this as a loss.
  };

  // MERGE-PUSH (no-clobber): reconcile with the server's current value before the
  // PUT so a concurrent add from the other device is not overwritten. A failed
  // GET defers (retry) rather than PUTting a clobbering raw local. Pass the
  // generation-aware gate so a logout/account-switch DURING the reconcile GET
  // aborts the local write (even if a NEW session re-opened the value gate).
  const reconciled = await reconcileForPush(plan.section, { isGateClosed: gateClosed });
  if (!reconciled.ok) {
    retry();
    return;
  }

  // Session boundary during the GET await → do not PUT another user's data, and
  // never with a token from a different session.
  if (typeof window === "undefined") return;
  if (gateClosed()) return;
  if (!isPushable(reconciled.value)) return;
  try {
    await dataApi.putData(plan.section, reconciled.value, csrfToken);
  } catch (err) {
    if (isTerminalPutRejection(err)) {
      // The server REJECTED this blob (HTTP 400 — e.g. it exceeds the size cap).
      // Retrying sends the SAME blob → the SAME rejection, so we do NOT retry and
      // do NOT swallow it: make the failure VISIBLE so the user knows the save did
      // not sync. Local is intact (never discarded); a later save that shrinks the
      // blob (e.g. the meals byte-prune) will sync. Silently dropping this is the
      // "meals don't sync" bug.
      notifySyncError({ section: plan.section });
      return;
    }
    retry();
  }
}

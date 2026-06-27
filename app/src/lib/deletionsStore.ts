// Delete TOMBSTONES — cross-device delete tracking.
//
// WHY THIS EXISTS: every cross-device merge in syncData.ts is a UNION (a record
// on EITHER side survives), which is what stops the original data-loss. But the
// flip side is that DELETING a record on one device does not stick: the next
// sync re-adds it from the other device's copy (Ao's "削除しても戻ってくる"). A
// pure union has no way to express "this id was intentionally removed".
//
// THE MODEL: a small, separately-synced `deletions` blob holds, per id, the
// LATEST op { at, state } where state is "deleted" or "cleared". Merging keeps
// the op with the latest `at` per id (a delete propagates; a later re-add wins).
// A record is suppressed ONLY when its id's latest op is a "deleted". Re-creating
// a previously-deleted id writes a NEWER "cleared" op (NOT a local-only removal),
// so the revive propagates cross-device too — without that, another device's old
// "deleted" op would re-import and re-suppress the re-added record (which matters
// most for weightLog, whose id is the reused date). Tombstones GC after 90 days
// (a re-add of an id deleted long ago would use a fresh id anyway).
//
// Pure helpers (no window) are unit-testable; the localStorage I/O is SSR-safe.

import type { DataSection } from "./dataApi";

/** The sections whose records are id-keyed and therefore tombstone-able. The
 *  single-object sections (profile/coachSettings/apiToken) are NOT here — they
 *  have no per-record id to tombstone. `chat` is intentionally EXCLUDED: there is
 *  no per-message delete UI (only a bulk clear), and a bulk clear shouldn't
 *  cross-device-erase another device's conversation. `deletions` is never
 *  tombstoned. */
export const TOMBSTONABLE_SECTIONS: readonly DataSection[] = [
  "meals",
  "workouts",
  "weightLog",
];

/** One id's latest delete/clear op. */
export interface DeletionOp {
  /** ISO timestamp of the op (latest wins on merge). */
  at: string;
  /** "deleted" → suppress the id; "cleared" → a re-add revived it (don't suppress). */
  state: "deleted" | "cleared";
}

/** Tombstone map: section → record id → latest op. */
export type DeletionsMap = Record<string, Record<string, DeletionOp>>;

export const DELETIONS_STORAGE_KEY = "health-app:deletions:v1";

/** Ops older than this are GC'd (all live clients have long since converged; a
 *  re-add of a long-ago-deleted id uses a fresh id so it can't be wrongly
 *  suppressed). */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function isOp(v: unknown): v is DeletionOp {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.at === "string" &&
    o.at.length > 0 &&
    (o.state === "deleted" || o.state === "cleared")
  );
}

/** SSR-safe + defensive parse into a clean DeletionsMap. Drops malformed entries.
 *  Tolerates the LEGACY shape `{section:{id: "<iso>"}}` (a bare deletedAt string)
 *  by lifting it to `{ at, state:"deleted" }`, so a blob written by an earlier
 *  build still works. Pure. */
export function sanitizeDeletions(raw: unknown): DeletionsMap {
  const out: DeletionsMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [section, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids || typeof ids !== "object" || Array.isArray(ids)) continue;
    const clean: Record<string, DeletionOp> = {};
    for (const [id, v] of Object.entries(ids as Record<string, unknown>)) {
      if (!id) continue;
      if (isOp(v)) clean[id] = { at: v.at, state: v.state };
      else if (typeof v === "string" && v) clean[id] = { at: v, state: "deleted" }; // legacy
    }
    if (Object.keys(clean).length > 0) out[section] = clean;
  }
  return out;
}

/**
 * Union two deletion maps: every (section,id) from either side survives; on a
 * collision the op with the LATER `at` wins (a delete propagates; a later
 * "cleared" re-add beats an older "deleted"). GC'd before returning so a stale op
 * isn't carried forward (and so the value PUT back to the server is also bounded).
 * Pure.
 */
export function mergeDeletions(local: unknown, server: unknown, now: number = Date.now()): DeletionsMap {
  const l = sanitizeDeletions(local);
  const s = sanitizeDeletions(server);
  const out: DeletionsMap = {};
  const sections = new Set([...Object.keys(l), ...Object.keys(s)]);
  for (const section of sections) {
    const li = l[section] ?? {};
    const si = s[section] ?? {};
    const merged: Record<string, DeletionOp> = { ...si };
    for (const [id, op] of Object.entries(li)) {
      const existing = merged[id];
      merged[id] = !existing || op.at > existing.at ? op : existing;
    }
    out[section] = merged;
  }
  return gcDeletions(out, now);
}

/** GC ops older than the TTL. Pure. */
export function gcDeletions(map: DeletionsMap, now: number = Date.now()): DeletionsMap {
  const out: DeletionsMap = {};
  for (const [section, ids] of Object.entries(map)) {
    const kept: Record<string, DeletionOp> = {};
    for (const [id, op] of Object.entries(ids)) {
      const t = Date.parse(op.at);
      if (!Number.isFinite(t) || now - t < TOMBSTONE_TTL_MS) kept[id] = op;
    }
    if (Object.keys(kept).length > 0) out[section] = kept;
  }
  return out;
}

/** The set of ids whose LATEST op is a "deleted" (i.e. to be suppressed) for one
 *  section. A "cleared" (revived) id is NOT in this set. Pure. */
export function tombstonedIds(map: DeletionsMap, section: DataSection): Set<string> {
  const ids = map[section] ?? {};
  const set = new Set<string>();
  for (const [id, op] of Object.entries(ids)) {
    if (op.state === "deleted") set.add(id);
  }
  return set;
}

// ---- localStorage I/O (SSR-safe) -------------------------------------------

export function loadDeletions(): DeletionsMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DELETIONS_STORAGE_KEY);
    if (!raw) return {};
    return gcDeletions(sanitizeDeletions(JSON.parse(raw)));
  } catch {
    return {};
  }
}

export function saveDeletions(map: DeletionsMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DELETIONS_STORAGE_KEY, JSON.stringify(gcDeletions(map)));
  } catch {
    /* quota/serialization errors are non-fatal */
  }
}

/** Write a "deleted" op for `id` in `section` (idempotent; refreshes `at`). */
export function addTombstone(section: DataSection, id: string, when: string = new Date().toISOString()): DeletionsMap {
  return writeOp(section, id, { at: when, state: "deleted" });
}

/** Write a "cleared" (revive) op for `id` — used when the id is RE-CREATED, so
 *  the re-add propagates cross-device and isn't re-suppressed by an older
 *  "deleted" op on another device. Returns true if an op was written (it only
 *  writes when a prior op exists, to avoid bloating the blob with clears for ids
 *  that were never deleted). */
export function clearTombstone(section: DataSection, id: string, when: string = new Date().toISOString()): boolean {
  const map = loadDeletions();
  if (!map[section] || !(id in map[section])) return false;
  // Only write a clear when the latest op is a delete (a re-clear is a no-op).
  if (map[section][id].state === "cleared") return false;
  writeOp(section, id, { at: when, state: "cleared" });
  return true;
}

/** Bulk "cleared" ops for any of `ids` that currently carry a "deleted" op. */
export function clearTombstones(section: DataSection, ids: Iterable<string>): boolean {
  const map = loadDeletions();
  const cur = map[section];
  if (!cur) return false;
  const when = new Date().toISOString();
  let changed = false;
  const next = { ...cur };
  for (const id of ids) {
    if (id && next[id] && next[id].state === "deleted") {
      next[id] = { at: when, state: "cleared" };
      changed = true;
    }
  }
  if (!changed) return false;
  saveDeletions({ ...map, [section]: next });
  return true;
}

/** Low-level: set one id's op and persist. Internal. */
function writeOp(section: DataSection, id: string, op: DeletionOp): DeletionsMap {
  const map = loadDeletions();
  const ids = { ...(map[section] ?? {}) };
  ids[id] = op;
  const next = { ...map, [section]: ids };
  saveDeletions(next);
  return next;
}

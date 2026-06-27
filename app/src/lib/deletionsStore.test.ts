import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  sanitizeDeletions,
  mergeDeletions,
  gcDeletions,
  tombstonedIds,
  addTombstone,
  clearTombstone,
  clearTombstones,
  loadDeletions,
  TOMBSTONE_TTL_MS,
  DELETIONS_STORAGE_KEY,
  type DeletionsMap,
} from "./deletionsStore";

// ─────────────────────────────────────────────────────────────────────────────
// Delete TOMBSTONES — the cross-device delete fix. A pure union would re-add a
// record deleted on one device; tombstones make the delete STICK and propagate,
// and a "cleared" op makes a RE-ADD propagate (so an older "deleted" on another
// device can't re-suppress it). End-to-end "delete sticks through the merge"
// lives in syncData.mergeOnLogin.test.ts; the live two-device proof is the
// browser test.
// ─────────────────────────────────────────────────────────────────────────────

const DEL = (at: string): { at: string; state: "deleted" } => ({ at, state: "deleted" });
const CLR = (at: string): { at: string; state: "cleared" } => ({ at, state: "cleared" });

function installLocalStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
  });
  return map;
}

describe("sanitizeDeletions", () => {
  it("keeps well-formed {section:{id:{at,state}}} and drops junk", () => {
    const out = sanitizeDeletions({
      meals: { a: DEL("2026-06-25T00:00:00Z"), "": DEL("x"), b: { at: 5 } },
      bad: "nope",
      workouts: { e1: CLR("2026-06-25T01:00:00Z") },
    });
    expect(out).toEqual({
      meals: { a: DEL("2026-06-25T00:00:00Z") },
      workouts: { e1: CLR("2026-06-25T01:00:00Z") },
    });
  });
  it("lifts the LEGACY bare-string shape to a deleted op", () => {
    const out = sanitizeDeletions({ meals: { a: "2026-06-25T00:00:00Z" } });
    expect(out.meals.a).toEqual(DEL("2026-06-25T00:00:00Z"));
  });
  it("returns {} for non-object / array input", () => {
    expect(sanitizeDeletions(null)).toEqual({});
    expect(sanitizeDeletions([1, 2])).toEqual({});
  });
});

describe("mergeDeletions — union, latest op wins (delete + revive propagate)", () => {
  const NOW = Date.parse("2026-06-25T12:00:00Z");
  it("unions sections + ids from both sides", () => {
    const out = mergeDeletions(
      { meals: { a: DEL("2026-06-25T00:00:00Z") } },
      { meals: { b: DEL("2026-06-25T00:00:00Z") }, workouts: { e1: DEL("2026-06-25T00:00:00Z") } },
      NOW,
    );
    expect(Object.keys(out.meals).sort()).toEqual(["a", "b"]);
    expect(out.workouts.e1).toEqual(DEL("2026-06-25T00:00:00Z"));
  });
  it("on id collision keeps the LATER `at` (a delete propagates)", () => {
    const out = mergeDeletions(
      { meals: { a: DEL("2026-06-25T10:00:00Z") } },
      { meals: { a: DEL("2026-06-25T08:00:00Z") } },
      NOW,
    );
    expect(out.meals.a.at).toBe("2026-06-25T10:00:00Z");
  });
  it("a later CLEARED op beats an older DELETED (re-add revive propagates)", () => {
    const out = mergeDeletions(
      { meals: { a: CLR("2026-06-25T11:00:00Z") } }, // this device re-added it
      { meals: { a: DEL("2026-06-25T09:00:00Z") } }, // other device still has the delete
      NOW,
    );
    expect(out.meals.a.state).toBe("cleared");
    // tombstonedIds excludes a cleared id → the re-add is NOT suppressed.
    expect(tombstonedIds(out, "meals").has("a")).toBe(false);
  });
});

describe("gcDeletions — drops ops older than TTL", () => {
  it("keeps fresh, drops stale (regardless of state)", () => {
    const now = Date.parse("2026-06-25T00:00:00Z");
    const fresh = new Date(now - 1000).toISOString();
    const stale = new Date(now - TOMBSTONE_TTL_MS - 1000).toISOString();
    const out = gcDeletions({ meals: { fresh: DEL(fresh), stale: DEL(stale) } }, now);
    expect(out.meals).toEqual({ fresh: DEL(fresh) });
  });
});

describe("tombstonedIds — only ids whose LATEST op is a delete", () => {
  it("includes deleted, excludes cleared", () => {
    const map: DeletionsMap = { meals: { a: DEL("t"), b: CLR("t"), c: DEL("t") } };
    expect([...tombstonedIds(map, "meals")].sort()).toEqual(["a", "c"]);
    expect(tombstonedIds(map, "chat").size).toBe(0);
  });
});

describe("localStorage I/O + add/clear (revive)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("addTombstone persists a deleted op; loadDeletions reads it back", () => {
    installLocalStorage({});
    addTombstone("meals", "m1", "2026-06-25T00:00:00Z");
    expect(loadDeletions().meals.m1).toEqual(DEL("2026-06-25T00:00:00Z"));
  });

  it("clearTombstone writes a CLEARED op (not a local removal) so the revive syncs", () => {
    installLocalStorage({
      [DELETIONS_STORAGE_KEY]: JSON.stringify({ meals: { m1: DEL("2026-06-25T00:00:00Z") } }),
    });
    expect(clearTombstone("meals", "m1", "2026-06-25T10:00:00Z")).toBe(true);
    const after = loadDeletions();
    expect(after.meals.m1).toEqual(CLR("2026-06-25T10:00:00Z")); // op kept, state flipped
    expect(tombstonedIds(after, "meals").has("m1")).toBe(false); // no longer suppressed
  });

  it("clearTombstone is a no-op when there is no prior op, or it's already cleared", () => {
    installLocalStorage({
      [DELETIONS_STORAGE_KEY]: JSON.stringify({ meals: { m1: CLR("2026-06-25T00:00:00Z") } }),
    });
    expect(clearTombstone("meals", "absent")).toBe(false);
    expect(clearTombstone("meals", "m1")).toBe(false); // already cleared
  });

  it("clearTombstones bulk-revives matching deleted ids only", () => {
    installLocalStorage({
      [DELETIONS_STORAGE_KEY]: JSON.stringify({
        weightLog: { "2026-06-20": DEL("t"), "2026-06-21": CLR("t") },
      }),
    });
    expect(clearTombstones("weightLog", ["2026-06-20", "2026-06-21", "zzz"])).toBe(true);
    const after = loadDeletions();
    expect(after.weightLog["2026-06-20"].state).toBe("cleared");
    expect(after.weightLog["2026-06-21"].state).toBe("cleared"); // was already cleared
  });

  it("clearTombstones returns false when nothing matches", () => {
    installLocalStorage({
      [DELETIONS_STORAGE_KEY]: JSON.stringify({ meals: { a: CLR("t") } }),
    });
    expect(clearTombstones("meals", ["a", "zzz"])).toBe(false); // a already cleared
  });
});

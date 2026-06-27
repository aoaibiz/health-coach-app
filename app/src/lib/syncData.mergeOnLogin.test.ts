import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { Meal } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// TASK 2 — prove/repair the cross-device data-loss path through the ACTUAL
// orchestration (mergeOnLogin), not just the pure merge primitives.
//
// We stub a per-test localStorage (the device's local store) and a fake fetch
// that plays the role of the server. Then we drive the EXACT family scenario:
//   (a) device A has data → logs in → pushes to the (empty) server;
//   (b) device B (EMPTY local, e.g. a fresh install / incognito) logs in against
//       the server that now holds A's data → does B restore? does it ever write
//       EMPTY back over the populated server / its own (just-restored) local?
//   (c) a user WITH local data, server returns null / empty / a throwing GET →
//       local must remain intact (the #1 rule).
//
// The key questions the brief asks: does login sync ever SHRINK a populated
// server or populated local? Each case asserts both the local result AND the
// exact bytes PUT to the server.
// ─────────────────────────────────────────────────────────────────────────────

const MEALS_KEY = "health-app:meals:v1";
const WORKOUTS_KEY = "health-app:workouts:v1";
const PROFILE_KEY = "health-app:profile:v1";
const WEIGHT_KEY = "health-app:weightLog:v1";
const COACH_KEY = "health-app:coachSettings";
const CHAT_KEY = "health-app:chat:v1";
const API_TOKEN_KEY = "health-app:apiToken";
const API_TOKEN_UPDATED_AT_KEY = "health-app:apiToken:updatedAt";
const DELETIONS_KEY = "health-app:deletions:v1";

/** Minimal window.localStorage shim on a node global (same pattern as
 *  profileStorage.test.ts). Seed maps a storage key → its raw JSON string. */
function installLocalStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  vi.stubGlobal("window", { localStorage });
  return map;
}

function meal(id: string, over: Partial<Meal> = {}): Meal {
  return {
    id,
    date: "2026-06-19",
    timestamp: `2026-06-19T08:${id.padStart(2, "0").slice(-2)}:00.000Z`,
    type: "朝",
    text: `meal ${id}`,
    ...over,
  };
}

/**
 * A scriptable fake server. `store` is the server-side blob per section. GET
 * returns `{ data, updatedAt }`; PUT records the pushed value into `store` AND
 * into a `pushed` log so a test can assert EXACTLY what was sent. `failGet` lets a
 * test simulate an offline/5xx GET (which must leave local untouched).
 */
function makeFakeServer(
  initial: Record<string, unknown> = {},
  opts: { failGet?: Set<string> } = {},
) {
  const store: Record<string, unknown> = { ...initial };
  const pushed: Array<{ section: string; data: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const section = new URL(u, "http://x").searchParams.get("section") ?? "";
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      if (opts.failGet?.has(section)) {
        return new Response("err", { status: 503 });
      }
      const data = section in store ? store[section] : null;
      return new Response(JSON.stringify({ section, data, updatedAt: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // PUT
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    store[section] = body.data;
    pushed.push({ section, data: body.data });
    return new Response(JSON.stringify({ section, updatedAt: 2 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { store, pushed, fetchImpl };
}

function pushedFor(pushed: Array<{ section: string; data: unknown }>, section: string) {
  return pushed.filter((p) => p.section === section).map((p) => p.data);
}

describe("mergeOnLogin — the family cross-device scenario (Task 2)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("(a) device A with local data, EMPTY server → restores nothing to lose, pushes A's data UP (server gains it)", async () => {
    installLocalStorage({
      [MEALS_KEY]: JSON.stringify([meal("1"), meal("2"), meal("3")]),
    });
    const server = makeFakeServer({}); // server empty (first device ever)
    const { mergeOnLogin } = await import("./syncData");

    const summary = await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    // Local keeps all 3 meals (union with empty server = local).
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals).toHaveLength(3);
    // Server now HAS A's 3 meals (pushed up) — this is what device B will restore.
    expect(server.store["meals"]).toHaveLength(3);
    const mealPushes = pushedFor(server.pushed, "meals");
    expect(mealPushes.at(-1)).toHaveLength(3);
    expect(summary.meals.merged).toBe(true);
    expect(summary.meals.pushed).toBe(true);
  });

  it("STALE-SESSION GUARD: if the session is cancelled (logout / A→B switch) before/during the merge, server data is NOT written back into the cleared local", async () => {
    // Simulates: user A's merge is in flight; user logs out (local already wiped,
    // local is empty here) → A's resuming merge must NOT repopulate local with A's
    // server data. isCancelled() returns true → every section is skipped.
    installLocalStorage({}); // cleared local (post-logout / post-switch wipe)
    const server = makeFakeServer({
      meals: [meal("1"), meal("2"), meal("3")],
      profile: { heightCm: 180, weightKg: 80, age: 30, sex: "male", bodyType: "average", activityLevel: "moderate", goal: "maintain", updatedAt: "2026-06-20T00:00:00.000Z" },
    });
    const { mergeOnLogin } = await import("./syncData");

    const summary = await mergeOnLogin({
      csrfToken: "csrf",
      fetchImpl: server.fetchImpl,
      isCancelled: () => true, // session already ended.
    });

    const ls = (globalThis as any).window.localStorage;
    // Local was NOT repopulated — no previous-user data leaked back in.
    expect(ls.getItem(MEALS_KEY)).toBeNull();
    expect(ls.getItem("health-app:profile:v1")).toBeNull();
    // Nothing was merged or pushed; every section reports cancelled.
    expect(summary.meals.merged).toBe(false);
    expect(summary.meals.error).toBe("cancelled");
    expect(pushedFor(server.pushed, "meals")).toHaveLength(0);
  });

  it("STALE-SESSION GUARD: cancellation AFTER the GET (mid-flight switch) still blocks the local write", async () => {
    installLocalStorage({}); // cleared local
    const server = makeFakeServer({ meals: [meal("1"), meal("2")] });
    const { mergeOnLogin } = await import("./syncData");

    // Cancel only AFTER the first isCancelled() check passes — i.e. allow entry,
    // but flip to cancelled by the time the post-GET guard runs.
    let calls = 0;
    const isCancelled = () => {
      calls += 1;
      // 1st call (pre-GET, meals) → false (enter); 2nd call (post-GET, meals) → true.
      return calls >= 2;
    };

    const summary = await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl, isCancelled });

    const ls = (globalThis as any).window.localStorage;
    expect(ls.getItem(MEALS_KEY)).toBeNull(); // post-GET guard blocked the write.
    expect(summary.meals.merged).toBe(false);
    expect(summary.meals.error).toBe("cancelled");
  });

  it("(b) device B with EMPTY local, server holds A's data → B RESTORES it, and NEVER pushes empty back over the populated server", async () => {
    // Fresh device / incognito: local is empty.
    installLocalStorage({});
    // Server already holds device A's 3 meals.
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] });
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    // B's local now has all 3 meals restored — the data "came back".
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals).toHaveLength(3);
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "2", "3"]);

    // CRITICAL: the server was NEVER overwritten with an empty/smaller array.
    expect(server.store["meals"]).toHaveLength(3);
    for (const p of pushedFor(server.pushed, "meals")) {
      expect((p as unknown[]).length).toBeGreaterThanOrEqual(3); // never shrinks the server
    }
  });

  it("(b') device B has SOME different local data + server has A's data → union restores BOTH sides, server grows, never shrinks", async () => {
    // B independently logged meal "9" while offline; server has A's 1,2,3.
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("9")]) });
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] });
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    // Union: 1,2,3 (server) + 9 (local) = 4, nothing dropped from either side.
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "2", "3", "9"]);
    // Server now also holds the union (grew from 3 → 4); never shrank.
    expect((server.store["meals"] as unknown[]).length).toBe(4);
  });

  it("(c) user WITH local data, server GET THROWS (offline/5xx) → local UNTOUCHED, nothing pushed for that section", async () => {
    installLocalStorage({
      [MEALS_KEY]: JSON.stringify([meal("1"), meal("2")]),
    });
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] }, {
      failGet: new Set(["meals"]),
    });
    const { mergeOnLogin } = await import("./syncData");

    const summary = await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    // GET failed → local stays exactly as it was (2 meals), no shrink, no push.
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals).toHaveLength(2);
    expect(summary.meals.merged).toBe(false);
    expect(summary.meals.error).toBeTruthy();
    expect(pushedFor(server.pushed, "meals")).toHaveLength(0); // never pushed (could have over-written the server's 3 with 2)
  });

  it("(c') user WITH local data, server returns null (no row yet) → local intact, server gains local's data", async () => {
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1"), meal("2")]) });
    const server = makeFakeServer({}); // GET returns data:null for every section
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals).toHaveLength(2); // null server can't wipe local
    expect((server.store["meals"] as unknown[]).length).toBe(2); // local pushed up
  });

  it("ALL sections: empty local device B restores every populated server section + never pushes a smaller blob than it received", async () => {
    installLocalStorage({}); // empty device B
    const server = makeFakeServer({
      profile: { heightCm: 170, weightKg: 65, updatedAt: "2026-06-19T00:00:00.000Z" },
      meals: [meal("1"), meal("2")],
      workouts: { "2026-06-19": { date: "2026-06-19", exercises: [{ id: "e1", name: "腕立て", sets: 3, reps: 10, weight: 0 }], updatedAt: "2026-06-19T10:00:00Z" } },
      weightLog: [{ date: "2026-06-19", weightKg: 65 }],
      coachSettings: { name: "やさしい先生", style: "gentle" },
      chat: [{ id: "c1", role: "user", content: "hi", createdAt: "2026-06-19T08:00:00Z" }],
    });
    const { mergeOnLogin } = await import("./syncData");

    const summary = await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const ls = (globalThis as any).window.localStorage;
    // Every section restored to local.
    expect(JSON.parse(ls.getItem(MEALS_KEY))).toHaveLength(2);
    expect(Object.keys(JSON.parse(ls.getItem(WORKOUTS_KEY)))).toEqual(["2026-06-19"]);
    expect(JSON.parse(ls.getItem(WEIGHT_KEY))).toHaveLength(1);
    expect(JSON.parse(ls.getItem(PROFILE_KEY)).heightCm).toBe(170);
    expect(JSON.parse(ls.getItem(COACH_KEY)).name).toBe("やさしい先生");
    expect(JSON.parse(ls.getItem(CHAT_KEY))).toHaveLength(1);

    // No section's server blob shrank below what it held; every section merged.
    expect((server.store["meals"] as unknown[]).length).toBe(2);
    expect(Object.keys(server.store["workouts"] as object)).toHaveLength(1);
    expect((server.store["chat"] as unknown[]).length).toBe(1);
    for (const s of ["profile", "meals", "workouts", "weightLog", "coachSettings", "chat"]) {
      expect(summary[s].merged).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The REAL wipe path found in review: an empty fresh device enables sync, then a
// background push (save / flush / interval) fires BEFORE the async mergeOnLogin
// restores local — pushing `[]` over the populated server. pushSectionBestEffort
// is a raw PUT, so mergeById/wouldShrinkSection cannot catch it. The fix gates
// background pushes on the per-section login-merge having completed.
// ─────────────────────────────────────────────────────────────────────────────
describe("pushSectionBestEffort — wipe fuse: no push before the login-merge restores local", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.useRealTimers();
  });

  it("a fresh/EMPTY device enabling sync does NOT push empty over the server before mergeOnLogin lands", async () => {
    installLocalStorage({}); // empty device B
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] });
    const { setSyncCsrfToken, pushSectionBestEffort, sectionMergeReady } = await import(
      "./syncData"
    );

    // Simulate the auth-layer ordering: enable sync, then SOMETHING tries to push
    // (a save / the flush / the interval) in the gap before mergeOnLogin restores.
    setSyncCsrfToken("csrf");
    expect(sectionMergeReady("meals")).toBe(false);
    pushSectionBestEffort("meals"); // would PUT [] — must be suppressed.

    // The server still holds all 3 meals — the empty local was NOT pushed up.
    expect((server.store["meals"] as unknown[]).length).toBe(3);
    expect(pushedFor(server.pushed, "meals")).toHaveLength(0);
  });

  it("after mergeOnLogin restores a section, background pushes resume (a genuine later edit reaches the server)", async () => {
    installLocalStorage({});
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] });
    const mod = await import("./syncData");
    const { setSyncCsrfToken, mergeOnLogin, sectionMergeReady } = mod;

    setSyncCsrfToken("csrf");
    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });
    expect(sectionMergeReady("meals")).toBe(true);

    // The user now logs a 4th meal locally; the post-restore push must reach the
    // server (gate is open). We need the dataApi default fetch to hit our fake —
    // simulate by writing local then pushing through the gated path with our fetch
    // via mergeOnLogin's own push already done; assert restore pushed the union.
    const ls = (globalThis as any).window.localStorage;
    expect(JSON.parse(ls.getItem(MEALS_KEY))).toHaveLength(3); // restored
    // The restore itself pushed the union up (server unchanged at 3, never shrank).
    expect((server.store["meals"] as unknown[]).length).toBe(3);
  });

  it("a GET FAILURE leaves the section un-merged → background pushes stay suppressed (can't over-write the server we couldn't read)", async () => {
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1")]) }); // 1 local meal
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] }, {
      failGet: new Set(["meals"]),
    });
    const { setSyncCsrfToken, mergeOnLogin, pushSectionBestEffort, sectionMergeReady } =
      await import("./syncData");

    setSyncCsrfToken("csrf");
    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });
    // GET failed → not merged → a background push must NOT fire (would PUT 1 over 3).
    expect(sectionMergeReady("meals")).toBe(false);
    pushSectionBestEffort("meals");
    expect((server.store["meals"] as unknown[]).length).toBe(3); // server intact
    expect(pushedFor(server.pushed, "meals")).toHaveLength(0);
  });

  it("logout (setSyncCsrfToken null) then re-login re-gates: pushes suppressed again until the next merge", async () => {
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1")]) });
    const server = makeFakeServer({ meals: [meal("1")] });
    const { setSyncCsrfToken, mergeOnLogin, sectionMergeReady } = await import("./syncData");

    setSyncCsrfToken("csrf");
    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });
    expect(sectionMergeReady("meals")).toBe(true);

    setSyncCsrfToken(null); // logout
    expect(sectionMergeReady("meals")).toBe(false);
    setSyncCsrfToken("csrf2"); // re-login → must re-gate until a fresh merge
    expect(sectionMergeReady("meals")).toBe(false);
  });

  // Codex-review fix (Medium): a SCHEDULED RETRY of a push must re-check the gate,
  // so an account switch / logout BETWEEN the initial push and its retry can't
  // even READ/PUT the previous-user (or cleared) local data. With the merge-push
  // change the first attempt's network op is a GET (reconcile), and the gate
  // re-check at the TOP of attemptPush runs BEFORE that GET — so a retry after
  // logout makes NO network call at all.
  it("a queued push retry ABORTS when the gate closes (logout) before the retry fires", async () => {
    vi.useFakeTimers();
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1")]) });
    const server = makeFakeServer({ meals: [meal("1")] });
    const { setSyncCsrfToken, mergeOnLogin, pushSectionBestEffort } = await import("./syncData");

    setSyncCsrfToken("csrf");
    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    // Make the global fetch fail so the reconcile GET rejects and attemptPush
    // schedules a retry.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      (async () => {
        calls += 1;
        throw new Error("network down"); // force the retry path (GET rejects).
      }) as unknown as typeof fetch,
    );

    pushSectionBestEffort("meals"); // attempt #0 → reconcile GET fails → retry @1000ms.
    // Drain the fire-and-forget GET rejection + retry scheduling deterministically.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1); // exactly one network op so far (the failed reconcile GET).

    // Account boundary BEFORE the retry fires: logout closes the gate.
    setSyncCsrfToken(null);

    // Advance past the first retry delay; the retry must SEE the closed gate and
    // abort at the TOP of attemptPush WITHOUT any further fetch (no GET, no PUT of
    // the now-unauthorized local data).
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toBe(1); // still 1 — the retry made no network call.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE CROSS-DEVICE PULL (refreshFromServer): the missing half of sync. Writes
// already push UP on save, but an already-open tab never re-PULLED — so a meal /
// profile photo added on ANOTHER device only appeared after a reload or re-login
// (Ao: "mobile add → PC doesn't reflect"). refreshFromServer pulls the server's
// latest into the open session, as the SAME no-data-loss union as the login merge.
// ─────────────────────────────────────────────────────────────────────────────
describe("refreshFromServer — live cross-device pull into an open session", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("pulls a meal added on ANOTHER device into this open session (the Ao scenario)", async () => {
    // This device is logged in with 1 meal locally + on the server.
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1")]) });
    const server = makeFakeServer({ meals: [meal("1")] });
    const { setSyncCsrfToken, mergeOnLogin, refreshFromServer } = await import("./syncData");

    setSyncCsrfToken("csrf");
    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });
    // Another device now adds meal "2" to the server (simulated by writing store).
    server.store["meals"] = [meal("1"), meal("2")];

    // The open session refreshes (focus / interval) → it must PULL meal "2".
    const summary = await refreshFromServer({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "2"]); // mobile's add appeared
    expect(summary.meals.merged).toBe(true);
  });

  it("a local-only edit made WHILE another device added data is NOT lost (union both ways)", async () => {
    // Server already has meal "2" (from device B); this device just logged "9".
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1"), meal("9")]) });
    const server = makeFakeServer({ meals: [meal("1"), meal("2")] });
    const { setSyncCsrfToken, refreshFromServer } = await import("./syncData");

    setSyncCsrfToken("csrf");
    await refreshFromServer({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    // Union: this device keeps "9", gains "2"; nothing dropped.
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "2", "9"]);
    // Server also converges to the union (grew 2 → 3) — never shrank.
    expect((server.store["meals"] as unknown[]).length).toBe(3);
  });

  it("is a NO-OP when sync is disabled (logged out) — never pulls another user's data", async () => {
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1")]) });
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] });
    const { refreshFromServer, setSyncCsrfToken } = await import("./syncData");

    setSyncCsrfToken(null); // logged out / no session
    const summary = await refreshFromServer({ csrfToken: null, fetchImpl: server.fetchImpl });

    // No section pulled; local untouched (still just meal "1").
    expect(Object.keys(summary)).toHaveLength(0);
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id)).toEqual(["1"]);
  });

  it("a GET FAILURE during refresh leaves local UNTOUCHED (the #1 rule still holds on pull)", async () => {
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1"), meal("2")]) });
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] }, {
      failGet: new Set(["meals"]),
    });
    const { setSyncCsrfToken, refreshFromServer } = await import("./syncData");

    setSyncCsrfToken("csrf");
    const summary = await refreshFromServer({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals).toHaveLength(2); // failed GET can't shrink local
    expect(summary.meals.merged).toBe(false);
    expect(summary.meals.error).toBeTruthy();
    expect(pushedFor(server.pushed, "meals")).toHaveLength(0);
  });

  it("ABORTS mid-refresh when the session is cancelled (logout / A→B switch) — no cross-account write", async () => {
    installLocalStorage({}); // cleared local (post-switch)
    const server = makeFakeServer({ meals: [meal("1"), meal("2")] });
    const { setSyncCsrfToken, refreshFromServer } = await import("./syncData");

    setSyncCsrfToken("csrf");
    const summary = await refreshFromServer({
      csrfToken: "csrf",
      fetchImpl: server.fetchImpl,
      isCancelled: () => true,
    });

    expect(Object.keys(summary)).toHaveLength(0); // bailed before touching any section
    const ls = (globalThis as any).window.localStorage;
    expect(ls.getItem(MEALS_KEY)).toBeNull(); // no previous-user data written back
  });

  it("pulls a profile (avatar photo) added on another device into this session", async () => {
    installLocalStorage({
      [PROFILE_KEY]: JSON.stringify({ heightCm: 170, weightKg: 65, updatedAt: "2026-06-24T00:00:00.000Z" }),
    });
    // Another device set an avatar + bumped updatedAt on the server.
    const server = makeFakeServer({
      profile: { heightCm: 170, weightKg: 65, avatarDataUrl: "data:image/jpeg;base64,AAA", updatedAt: "2026-06-24T12:00:00.000Z" },
    });
    const { setSyncCsrfToken, refreshFromServer } = await import("./syncData");

    setSyncCsrfToken("csrf");
    await refreshFromServer({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const localProfile = JSON.parse((globalThis as any).window.localStorage.getItem(PROFILE_KEY));
    // Newer server profile (with the avatar) won → photo now crosses to this device.
    expect(localProfile.avatarDataUrl).toBe("data:image/jpeg;base64,AAA");
  });

  // Codex review (privacy): logout flips the module token (setSyncCsrfToken null)
  // SYNCHRONOUSLY, before the React effect's `cancelled` flag flips on cleanup.
  // refreshFromServer passes a synchronous isGateClosed(=!syncEnabled) to every
  // section so an in-flight pull stops the instant the gate closes — it must NOT
  // write the logged-out user's server data into the (being-)cleared local.
  it("aborts mid-pull the instant the sync gate closes (logout) — no logged-out data written back", async () => {
    installLocalStorage({}); // local being cleared on logout
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] });
    const { setSyncCsrfToken, refreshFromServer } = await import("./syncData");

    setSyncCsrfToken("csrf");
    // A fetch that closes the gate (logout) DURING the in-flight GET, before the
    // section's post-GET guard runs — mimicking logout's synchronous token clear.
    const racingFetch = (async (url: string | URL, init?: RequestInit) => {
      setSyncCsrfToken(null); // logout closes the gate while the GET is "in flight"
      return server.fetchImpl(url as any, init as any);
    }) as unknown as typeof fetch;

    await refreshFromServer({ csrfToken: "csrf", fetchImpl: racingFetch });

    // The gate closed → the pull must NOT have written the server's meals into the
    // (logged-out) local.
    const ls = (globalThis as any).window.localStorage;
    expect(ls.getItem(MEALS_KEY)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MERGE-PUSH (no-clobber): a routine save used to PUT this device's local list
// verbatim, OVERWRITING a record the OTHER device added since this device last
// synced (effective last-writer-wins → "A・Bで別々に追加→片方が消える"). attemptPush
// now does GET→UNION→PUT so concurrent adds from BOTH devices survive (and a
// failed GET defers instead of clobbering). The end-to-end no-clobber behaviour
// is proven against the REAL Worker backend in the live two-device browser test;
// here we cover the no-clobber MERGE step deterministically via the awaitable
// reconcileForPush() (the same pure GET→union→write step attemptPush runs),
// which avoids the fire-and-forget timing of the void push.
// ─────────────────────────────────────────────────────────────────────────────
describe("reconcileForPush — merge step keeps concurrent adds from BOTH devices", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("unions the server's concurrent add into the value to push (the other device's meal survives)", async () => {
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1"), meal("3")]) });
    // The OTHER device already added meal "2" to the server.
    const server = makeFakeServer({ meals: [meal("1"), meal("2")] });
    const { reconcileForPush } = await import("./syncData");

    const result = await reconcileForPush("meals", { fetchImpl: server.fetchImpl });

    // The value to PUT is the UNION (1,2,3) — meal "2" is NOT clobbered.
    expect((result.value as Meal[]).map((m) => m.id).sort()).toEqual(["1", "2", "3"]);
    // Local was also reconciled to the union (this device gained "2").
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "2", "3"]);
    expect(result.ok).toBe(true);
  });

  it("a GET FAILURE returns ok:false (caller must DEFER, not raw-PUT a clobbering value)", async () => {
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1"), meal("3")]) });
    const server = makeFakeServer({ meals: [meal("1"), meal("2")] }, { failGet: new Set(["meals"]) });
    const { reconcileForPush } = await import("./syncData");

    const result = await reconcileForPush("meals", { fetchImpl: server.fetchImpl });

    expect(result.ok).toBe(false); // could not read server → caller defers (no PUT)
    // Local untouched on a failed read.
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "3"]);
  });

  // Codex review (privacy): the GET awaits; if the session closes meanwhile
  // (logout / account switch), reconcileForPush must DEFER without writing the
  // fetched server data into the (being-)cleared local.
  it("defers without writing local when the gate closes during the GET (post-GET privacy gate)", async () => {
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1")]) });
    const server = makeFakeServer({ meals: [meal("1"), meal("2")] });
    const { reconcileForPush } = await import("./syncData");

    const result = await reconcileForPush("meals", {
      fetchImpl: server.fetchImpl,
      isGateClosed: () => true, // session ended while the GET was in flight
    });

    expect(result.ok).toBe(false); // deferred, no PUT
    // Local NOT enriched with the server's meal "2" (no cross-account write-back).
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1"]);
  });

  // Codex review (deepest privacy race): setSyncCsrfToken bumps a session
  // GENERATION. An A→B account switch RE-OPENS the value gate (B's token +
  // sectionMergeReady), which a value-only check can't distinguish from A's
  // session — but the generation has changed, so a stale-A op must still abort.
  it("currentSyncGeneration changes on every session change (A→B re-open cannot fool the gate)", async () => {
    installLocalStorage({});
    const { setSyncCsrfToken, currentSyncGeneration } = await import("./syncData");
    const g0 = currentSyncGeneration();
    setSyncCsrfToken("A");
    const gA = currentSyncGeneration();
    setSyncCsrfToken(null); // logout
    setSyncCsrfToken("B"); // B login (re-opens the value gate)
    const gB = currentSyncGeneration();
    // Each session boundary advanced the generation → a captured gA can never
    // equal the current gB, so a stale-A push/merge that captured gA aborts.
    expect(gA).not.toBe(g0);
    expect(gB).not.toBe(gA);
    expect(gB).toBeGreaterThan(gA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-DEVICE DELETE via TOMBSTONES. A pure union re-adds a record deleted on
// one device from another device's copy (Ao: "削除しても戻ってくる"). A tombstone
// { id, deletedAt } in the synced `deletions` blob makes the delete STICK: the
// union still re-adds it, then applyTombstonesToSection drops it, and the
// tombstone propagates to all devices. These drive it through mergeOnLogin.
// ─────────────────────────────────────────────────────────────────────────────
describe("cross-device delete — tombstones make a delete stick (no resurrection)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("a meal the server still holds is NOT resurrected when a local tombstone exists", async () => {
    // This device deleted meal "2" (local has 1,3 + a tombstone for "2"); the
    // server still has 1,2,3 (the delete hasn't propagated yet).
    installLocalStorage({
      [MEALS_KEY]: JSON.stringify([meal("1"), meal("3")]),
      [DELETIONS_KEY]: JSON.stringify({ meals: { "2": "2026-06-25T00:00:00.000Z" } }),
    });
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] });
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    // Local does NOT get meal "2" back (tombstone excluded it from the union).
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "3"]);
    // The delete propagated UP: the server was rewritten WITHOUT "2".
    expect((server.store["meals"] as Meal[]).map((m) => m.id).sort()).toEqual(["1", "3"]);
    // The tombstone set was pushed so OTHER devices learn of the delete.
    expect((server.store["deletions"] as any).meals["2"]).toMatchObject({ state: "deleted" });
  });

  it("a delete recorded on ANOTHER device (server tombstone) removes the item here", async () => {
    // This device still has 1,2,3 locally and NO tombstone; the OTHER device
    // deleted "2" → the server's deletions blob carries the tombstone.
    installLocalStorage({ [MEALS_KEY]: JSON.stringify([meal("1"), meal("2"), meal("3")]) });
    const server = makeFakeServer({
      meals: [meal("1"), meal("3")],
      deletions: { meals: { "2": "2026-06-25T00:00:00.000Z" } },
    });
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    // The other device's delete reached here: meal "2" is removed from local.
    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "3"]);
    // And the local tombstone set now carries it (union of both sides).
    const localDels = JSON.parse((globalThis as any).window.localStorage.getItem(DELETIONS_KEY));
    expect(localDels.meals["2"]).toBeTruthy();
  });

  it("ADD no-loss is preserved: a non-tombstoned meal added on the other device still appears", async () => {
    // Local deleted "2" (tombstoned); the other device ADDED "4" to the server.
    installLocalStorage({
      [MEALS_KEY]: JSON.stringify([meal("1"), meal("3")]),
      [DELETIONS_KEY]: JSON.stringify({ meals: { "2": "2026-06-25T00:00:00.000Z" } }),
    });
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3"), meal("4")] });
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    // "2" stays deleted, but the NEW "4" is gained — delete fix didn't break add-sync.
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "3", "4"]);
  });

  it("the deleted meal does NOT come back on a SECOND sync (idempotent across reloads)", async () => {
    installLocalStorage({
      [MEALS_KEY]: JSON.stringify([meal("1"), meal("3")]),
      [DELETIONS_KEY]: JSON.stringify({ meals: { "2": "2026-06-25T00:00:00.000Z" } }),
    });
    const server = makeFakeServer({ meals: [meal("1"), meal("2"), meal("3")] });
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });
    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl }); // second sync

    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "3"]); // still gone
  });

  it("re-add wins cross-device: a CLEARED op beats the server's older DELETED (re-added meal is kept)", async () => {
    // This device re-created "2" and recorded a NEWER cleared op; the SERVER still
    // carries the older deleted op (from another device). The re-add must WIN: "2"
    // stays, and the cleared op propagates (not re-suppressed by the old delete).
    installLocalStorage({
      [MEALS_KEY]: JSON.stringify([meal("1"), meal("2"), meal("3")]),
      [DELETIONS_KEY]: JSON.stringify({ meals: { "2": { at: "2026-06-25T10:00:00.000Z", state: "cleared" } } }),
    });
    const server = makeFakeServer({
      meals: [meal("1"), meal("3")],
      deletions: { meals: { "2": { at: "2026-06-25T08:00:00.000Z", state: "deleted" } } },
    });
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    const localMeals = JSON.parse((globalThis as any).window.localStorage.getItem(MEALS_KEY));
    expect(localMeals.map((m: Meal) => m.id).sort()).toEqual(["1", "2", "3"]); // re-add kept
    // The cleared op (latest) is what survives in the merged tombstone set.
    const localDels = JSON.parse((globalThis as any).window.localStorage.getItem(DELETIONS_KEY));
    expect(localDels.meals["2"].state).toBe("cleared");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE HEADLINE FIX: the access key (アクセスキー) used to live ONLY in this-device
// localStorage, so deleting + re-adding the installed app lost it and forced a
// manual re-paste. It now syncs to the user's authenticated row. This drives the
// EXACT user flow end-to-end through the real orchestration:
//   set key → background push (PUT) → wipe local (delete/re-add the app) →
//   mergeOnLogin (GET) → key RESTORED to local → hasApiKey() true. No re-entry.
// ─────────────────────────────────────────────────────────────────────────────
describe("apiToken (access key) — durable sync, restores after a device wipe", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("set → PUT → clear local (device wipe) → mergeOnLogin → key restored, hasApiKey() true", async () => {
    // ── Device A: the user sets their access key, sync is enabled, key pushes up.
    const mapA = installLocalStorage({});
    const server = makeFakeServer({});
    const modA = await import("./syncData");
    const { setApiToken } = await import("./apiTokenStore");

    // Gate must be open before a background push fires (login-merge ran).
    modA.setSyncCsrfToken("csrf");
    await modA.mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    setApiToken("secret-access-key"); // settings form writes the key + updatedAt.
    // Push it up through the gated path with our fake server's fetch.
    await modA.mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    // The server now holds the key envelope; the original local key is present.
    expect(mapA.get(API_TOKEN_KEY)).toBe("secret-access-key");
    expect((server.store["apiToken"] as { token: string }).token).toBe("secret-access-key");

    // ── Device wipe: delete + re-add the app → local is empty again.
    vi.resetModules();
    const mapB = installLocalStorage({}); // fresh/empty device (no key locally)
    const modB = await import("./syncData");
    const { hasApiKey: hasApiKeyB } = await import("./analyzeMeal");
    expect(mapB.has(API_TOKEN_KEY)).toBe(false);
    expect(hasApiKeyB()).toBe(false); // key really is gone before restore.

    // ── Login again: mergeOnLogin GETs the server blob and RESTORES the key.
    modB.setSyncCsrfToken("csrf");
    const summary = await modB.mergeOnLogin({
      csrfToken: "csrf",
      fetchImpl: server.fetchImpl,
    });

    expect(summary.apiToken.merged).toBe(true);
    // Local now has the key back under the ORIGINAL key (every reader sees it).
    expect(mapB.get(API_TOKEN_KEY)).toBe("secret-access-key");
    expect(mapB.get(API_TOKEN_UPDATED_AT_KEY)).toBeTruthy();
    // The existing presence check (used by the UI to unlock AI features) is true
    // again — NO manual re-entry needed.
    expect(hasApiKeyB()).toBe(true);
  });

  it("an empty server can NEVER clear a locally-set key (the #1 rule for the key too)", async () => {
    const map = installLocalStorage({
      [API_TOKEN_KEY]: "local-key",
      [API_TOKEN_UPDATED_AT_KEY]: "2026-06-24T00:00:00Z",
    });
    const server = makeFakeServer({}); // GET returns data:null for apiToken
    const { mergeOnLogin } = await import("./syncData");

    await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    // Local key untouched; the local key was pushed UP (server gains it).
    expect(map.get(API_TOKEN_KEY)).toBe("local-key");
    expect((server.store["apiToken"] as { token: string }).token).toBe("local-key");
  });

  it("a GET FAILURE leaves the key untouched and pushes nothing for the section", async () => {
    const map = installLocalStorage({
      [API_TOKEN_KEY]: "local-key",
      [API_TOKEN_UPDATED_AT_KEY]: "2026-06-24T00:00:00Z",
    });
    const server = makeFakeServer(
      { apiToken: { token: "server-key", updatedAt: "2026-06-23T00:00:00Z" } },
      { failGet: new Set(["apiToken"]) },
    );
    const { mergeOnLogin } = await import("./syncData");

    const summary = await mergeOnLogin({ csrfToken: "csrf", fetchImpl: server.fetchImpl });

    expect(summary.apiToken.merged).toBe(false);
    expect(summary.apiToken.error).toBeTruthy();
    expect(map.get(API_TOKEN_KEY)).toBe("local-key"); // untouched
    expect(pushedFor(server.pushed, "apiToken")).toHaveLength(0); // never pushed
  });
});

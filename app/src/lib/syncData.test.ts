import { afterEach, describe, it, expect, vi } from "vitest";
import {
  buildExport,
  importFromJson,
  mergeById,
  mergeMeals,
  mergeWorkouts,
  mergeWeightLog,
  mergeProfile,
  mergeCoachSettings,
  mergeChat,
  mergeApiToken,
  wouldShrinkSection,
  applyTombstonesToSection,
} from "./syncData";
import type { Meal, Profile, Workout } from "./types";
import type { WeightEntry } from "./weightLog";
import type { CoachSettings } from "./coachSettings";
import type { ChatMessage } from "./chatStore";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function meal(id: string, over: Partial<Meal> = {}): Meal {
  return {
    id,
    date: "2026-06-19",
    timestamp: `2026-06-19T08:0${id.length}:00.000Z`,
    type: "朝",
    text: `meal ${id}`,
    ...over,
  };
}

function workout(date: string, updatedAt: string): Workout {
  return { date, exercises: [{ id: `e-${date}`, name: "腕立て", sets: 3, reps: 10, weight: 0 }], updatedAt };
}

function profile(over: Partial<Profile> = {}): Profile {
  return {
    heightCm: 170,
    weightKg: 65,
    bodyType: "average",
    age: 30,
    sex: "male",
    activityLevel: "moderate",
    goal: "maintain",
    updatedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

function chat(id: string, createdAt: string): ChatMessage {
  return { id, role: "user", content: `msg ${id}`, createdAt };
}

// ─── Shrink fuse ─────────────────────────────────────────────────────────────

describe("wouldShrinkSection", () => {
  it("blocks a login-sync write that would reduce record counts", () => {
    expect(wouldShrinkSection("meals", [meal("a"), meal("b")], [meal("a")])).toBe(true);
    expect(wouldShrinkSection("workouts", { a: workout("2026-06-18", "t") }, {})).toBe(true);
    expect(wouldShrinkSection("chat", [chat("a", "2026-06-19T08:00:00Z")], [])).toBe(true);
  });

  it("allows same-size or larger union writes", () => {
    expect(wouldShrinkSection("meals", [meal("a")], [meal("a"), meal("b")])).toBe(false);
    expect(wouldShrinkSection("weightLog", [], [{ date: "2026-06-19", weightKg: 65 }])).toBe(false);
    expect(wouldShrinkSection("coachSettings", { name: "やさしい先生" }, { name: "やさしい先生", style: "gentle" })).toBe(false);
  });
});

// ─── mergeById (the union primitive) ──────────────────────────────────────────

describe("mergeById — union, never drops a record", () => {
  it("local-only → all local records survive", () => {
    const out = mergeById([{ id: "a" }, { id: "b" }], []);
    expect(out.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
  it("server-only → all server records survive", () => {
    const out = mergeById([], [{ id: "a" }, { id: "b" }]);
    expect(out.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
  it("both present (disjoint) → union of both, nothing lost", () => {
    const out = mergeById([{ id: "a" }], [{ id: "b" }]);
    expect(out.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
  it("id collision → keeps the MORE COMPLETE version (no loss)", () => {
    const local = [{ id: "a", text: "full", note: "x" }];
    const server = [{ id: "a", text: "" }];
    const out = mergeById(local, server);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", text: "full", note: "x" });
  });
  it("empty server can NEVER reduce a local set", () => {
    const local = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(mergeById(local, []).length).toBe(local.length);
  });
});

// ─── meals ────────────────────────────────────────────────────────────────────

describe("mergeMeals", () => {
  it("local-only", () => {
    expect(mergeMeals([meal("a"), meal("bb")], null).map((m) => m.id).sort()).toEqual([
      "a",
      "bb",
    ]);
  });
  it("server-only (local empty) → adopts server, local NOT wiped to empty", () => {
    const out = mergeMeals([], [meal("a"), meal("bb")]);
    expect(out.map((m) => m.id).sort()).toEqual(["a", "bb"]);
  });
  it("both present → union, no meal lost", () => {
    const out = mergeMeals([meal("a")], [meal("bb")]);
    expect(out.map((m) => m.id).sort()).toEqual(["a", "bb"]);
  });
  it("empty/null server must NOT wipe local meals (#1 rule)", () => {
    expect(mergeMeals([meal("a"), meal("bb")], null)).toHaveLength(2);
    expect(mergeMeals([meal("a"), meal("bb")], [])).toHaveLength(2);
    expect(mergeMeals([meal("a"), meal("bb")], { garbage: true })).toHaveLength(2);
  });
  it("collision prefers the meal WITH nutrition (more complete)", () => {
    const enriched = meal("a", { nutrition: { calories: 500 } });
    const bare = meal("a");
    const out = mergeMeals([bare], [enriched]);
    expect(out[0].nutrition?.calories).toBe(500);
  });

  it("preserves a fresh generated icon from local when server has the more complete meal", () => {
    const localWithIcon = meal("a", {
      text: "焼き芋",
      generatedImageId: "generated-yakiimo",
      generatedImageDataUrl: "data:image/webp;base64,YAKIIMO",
      generatedImagePrompt: "焼き芋",
    });
    const serverWithNutrition = meal("a", {
      text: "焼き芋",
      nutrition: { calories: 113, proteinG: 1, fatG: 0, carbG: 29 },
    });

    const out = mergeMeals([localWithIcon], [serverWithNutrition]);

    expect(out[0].nutrition?.calories).toBe(113);
    expect(out[0].generatedImageDataUrl).toBe("data:image/webp;base64,YAKIIMO");
    expect(out[0].generatedImagePrompt).toBe("焼き芋");
  });

  it("preserves a fresh generated icon from server when local has the more complete meal", () => {
    const localWithNutrition = meal("a", {
      text: "ブラックコーヒー",
      nutrition: { calories: 8, proteinG: 0, fatG: 0, carbG: 1 },
    });
    const serverWithIcon = meal("a", {
      text: "ブラックコーヒー",
      generatedImageId: "generated-coffee",
      generatedImageDataUrl: "data:image/webp;base64,COFFEE",
      generatedImagePrompt: "ブラックコーヒー",
    });

    const out = mergeMeals([localWithNutrition], [serverWithIcon]);

    expect(out[0].nutrition?.calories).toBe(8);
    expect(out[0].generatedImageDataUrl).toBe("data:image/webp;base64,COFFEE");
    expect(out[0].generatedImagePrompt).toBe("ブラックコーヒー");
    expect(out[0].generatedImageId).toBeUndefined();
  });

  it("does not sync remote generated blob ids to another device", () => {
    const out = mergeMeals(
      [],
      [
        meal("a", {
          text: "焼き芋",
          generatedImageId: "remote-indexeddb-only-id",
          generatedImageDataUrl: "data:image/webp;base64,YAKIIMO",
          generatedImagePrompt: "焼き芋",
        }),
      ],
    );

    expect(out[0].generatedImageDataUrl).toBe("data:image/webp;base64,YAKIIMO");
    expect(out[0].generatedImagePrompt).toBe("焼き芋");
    expect(out[0].generatedImageId).toBeUndefined();
  });

  it("does not let a remote-only generated blob id suppress regeneration", () => {
    const out = mergeMeals(
      [],
      [
        meal("a", {
          text: "焼き芋",
          generatedImageId: "remote-indexeddb-only-id",
          generatedImagePrompt: "焼き芋",
        }),
      ],
    );

    expect(out[0].generatedImageDataUrl).toBeUndefined();
    expect(out[0].generatedImageId).toBeUndefined();
    expect(out[0].generatedImagePrompt).toBe("焼き芋");
  });

  it("preserves the local generated blob reference when thumbnail sync failed and server is more complete", () => {
    const localWithFailedThumbnail = meal("a", {
      text: "プロテイン",
      generatedImageId: "generated-protein",
      generatedImagePrompt: "プロテイン",
      generatedImageDataUrlFailedPrompt: "プロテイン",
    });
    const serverWithNutrition = meal("a", {
      text: "プロテイン",
      nutrition: { calories: 80, proteinG: 16, fatG: 1, carbG: 2 },
    });

    const out = mergeMeals([localWithFailedThumbnail], [serverWithNutrition]);

    expect(out[0].nutrition?.calories).toBe(80);
    expect(out[0].generatedImageId).toBe("generated-protein");
    expect(out[0].generatedImagePrompt).toBe("プロテイン");
    expect(out[0].generatedImageDataUrlFailedPrompt).toBe("プロテイン");
  });

  it("keeps the local generated blob reference when server has the synced data URL but no local id", () => {
    const localWithBlob = meal("a", {
      text: "焼き芋",
      generatedImageId: "local-generated-yakiimo",
      generatedImagePrompt: "焼き芋",
    });
    const serverWithSyncedIcon = meal("a", {
      text: "焼き芋",
      generatedImageDataUrl: "data:image/webp;base64,YAKIIMO",
      generatedImagePrompt: "焼き芋",
      nutrition: { calories: 113, proteinG: 1, fatG: 0, carbG: 29 },
    });

    const out = mergeMeals([localWithBlob], [serverWithSyncedIcon]);

    expect(out[0].nutrition?.calories).toBe(113);
    expect(out[0].generatedImageDataUrl).toBe("data:image/webp;base64,YAKIIMO");
    expect(out[0].generatedImageId).toBe("local-generated-yakiimo");
    expect(out[0].generatedImagePrompt).toBe("焼き芋");
  });

  it("drops a stale synced data URL when preserving a current local generated blob reference", () => {
    const localWithCurrentBlob = meal("a", {
      text: "焼き芋",
      generatedImageId: "local-generated-yakiimo",
      generatedImagePrompt: "焼き芋",
    });
    const serverWithStaleSyncedIcon = meal("a", {
      text: "焼き芋",
      generatedImageDataUrl: "data:image/webp;base64,KARAAGE",
      generatedImagePrompt: "唐揚げ",
      nutrition: { calories: 113, proteinG: 1, fatG: 0, carbG: 29 },
    });

    const out = mergeMeals([localWithCurrentBlob], [serverWithStaleSyncedIcon]);

    expect(out[0].nutrition?.calories).toBe(113);
    expect(out[0].generatedImageDataUrl).toBeUndefined();
    expect(out[0].generatedImageId).toBe("local-generated-yakiimo");
    expect(out[0].generatedImagePrompt).toBe("焼き芋");
  });

  it("drops invalid or oversized generated data URLs before merging or pushing", () => {
    const oversized = "data:image/webp;base64," + "A".repeat(120_000);
    const out = mergeMeals(
      [
        meal("a", {
          generatedImageDataUrl: oversized,
          generatedImagePrompt: "meal a",
        }),
      ],
      null,
    );

    expect(out[0].generatedImageDataUrl).toBeUndefined();
    expect(out[0].generatedImagePrompt).toBe("meal a");
  });

  it("uses the same short capped prompt as generation when validating synced meal icons", () => {
    const out = mergeMeals(
      [
        meal("a", {
          text: "焼き芋。これは個人的なメモです",
          generatedImageDataUrl: "data:image/webp;base64,YAKIIMO",
          generatedImagePrompt: "焼き芋",
          generatedImageDataUrlFailedPrompt: "焼き芋",
        }),
      ],
      null,
    );

    expect(out[0].generatedImageDataUrl).toBe("data:image/webp;base64,YAKIIMO");
    expect(out[0].generatedImageDataUrlFailedPrompt).toBe("焼き芋");
  });

  it("does not attach an old-menu generated data URL to a newer text edit during merge", () => {
    const localNewText = meal("a", {
      text: "焼き芋",
      nutrition: { calories: 113 },
    });
    const serverOldImage = meal("a", {
      text: "唐揚げ",
      generatedImageDataUrl: "data:image/webp;base64,KARAAGE",
      generatedImagePrompt: "唐揚げ",
    });

    const out = mergeMeals([localNewText], [serverOldImage]);

    expect(out[0].text).toBe("焼き芋");
    expect(out[0].generatedImageDataUrl).toBeUndefined();
    expect(out[0].generatedImagePrompt).toBeUndefined();
  });

  it("prefers the newer meal edit over an older more-complete record", () => {
    const localNewEdit = meal("a", {
      text: "焼き芋",
      updatedAt: "2026-06-27T12:00:00.000Z",
    });
    const serverOldComplete = meal("a", {
      text: "唐揚げ",
      updatedAt: "2026-06-27T11:00:00.000Z",
      nutrition: { calories: 500 },
      generatedImageDataUrl: "data:image/webp;base64,KARAAGE",
      generatedImagePrompt: "唐揚げ",
    });

    const out = mergeMeals([localNewEdit], [serverOldComplete]);

    expect(out[0].text).toBe("焼き芋");
    expect(out[0].updatedAt).toBe("2026-06-27T12:00:00.000Z");
    expect(out[0].generatedImageDataUrl).toBeUndefined();
  });
});

function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
    dispatchEvent: () => true,
  });
  vi.stubGlobal("StorageEvent", class StorageEvent extends Event {});
  return store;
}

describe("manual export/import redacts access keys", () => {
  it("excludes apiToken from manual JSON exports", () => {
    installLocalStorage({
      "health-app:apiToken": "secret-token",
      "health-app:apiToken:updatedAt": "2026-06-27T00:00:00.000Z",
    });

    const exported = buildExport();

    expect(exported.sections.apiToken).toBeUndefined();
  });

  it("ignores apiToken when importing a backup JSON", () => {
    const store = installLocalStorage();
    const result = importFromJson(
      JSON.stringify({
        app: "health-app",
        version: 1,
        sections: {
          apiToken: { token: "imported-secret", updatedAt: "2026-06-27T00:00:00.000Z" },
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(store.get("health-app:apiToken")).toBeUndefined();
  });
});

// ─── workouts ──────────────────────────────────────────────────────────────────

describe("mergeWorkouts", () => {
  const a = { "2026-06-18": workout("2026-06-18", "2026-06-18T10:00:00Z") };
  const b = { "2026-06-19": workout("2026-06-19", "2026-06-19T10:00:00Z") };

  it("local-only / server-only", () => {
    expect(Object.keys(mergeWorkouts(a, null))).toEqual(["2026-06-18"]);
    expect(Object.keys(mergeWorkouts({}, b))).toEqual(["2026-06-19"]);
  });
  it("both present → union of days", () => {
    expect(Object.keys(mergeWorkouts(a, b)).sort()).toEqual(["2026-06-18", "2026-06-19"]);
  });
  it("same-day collision → newer updatedAt wins for the day's timestamp", () => {
    const older = { "2026-06-19": workout("2026-06-19", "2026-06-19T08:00:00Z") };
    const newer = workout("2026-06-19", "2026-06-19T20:00:00Z");
    const out = mergeWorkouts(older, { "2026-06-19": newer });
    expect(out["2026-06-19"].updatedAt).toBe("2026-06-19T20:00:00Z");
  });
  it("empty/null server must NOT wipe local workouts", () => {
    expect(Object.keys(mergeWorkouts(a, null))).toEqual(["2026-06-18"]);
    expect(Object.keys(mergeWorkouts(a, {}))).toEqual(["2026-06-18"]);
  });

  // Codex review: same-day collision must UNION exercises by id — two devices each
  // adding a DIFFERENT exercise to the same day must BOTH survive (not day-level LWW).
  it("same-day collision → exercises are UNION-merged by id (both devices' adds survive)", () => {
    const ex = (id: string) => ({ id, name: `ex-${id}`, sets: 3, reps: 10, weight: 0 });
    const localDay = {
      "2026-06-19": { date: "2026-06-19", exercises: [ex("a")], updatedAt: "2026-06-19T08:00:00Z" },
    };
    const serverDay = {
      "2026-06-19": { date: "2026-06-19", exercises: [ex("b")], updatedAt: "2026-06-19T20:00:00Z" },
    };
    const out = mergeWorkouts(localDay, serverDay);
    const ids = out["2026-06-19"].exercises.map((e) => e.id).sort();
    expect(ids).toEqual(["a", "b"]); // neither exercise dropped
    expect(out["2026-06-19"].updatedAt).toBe("2026-06-19T20:00:00Z"); // latest day stamp
  });
});

// ─── weightLog ──────────────────────────────────────────────────────────────────

describe("mergeWeightLog", () => {
  const local: WeightEntry[] = [
    { date: "2026-06-18", weightKg: 65 },
    { date: "2026-06-19", weightKg: 64.5 },
  ];
  const server: WeightEntry[] = [{ date: "2026-06-17", weightKg: 66 }];

  it("local-only / server-only", () => {
    expect(mergeWeightLog(local, null).map((e) => e.date)).toEqual(["2026-06-18", "2026-06-19"]);
    expect(mergeWeightLog([], server).map((e) => e.date)).toEqual(["2026-06-17"]);
  });
  it("both present → union of dates, sorted", () => {
    expect(mergeWeightLog(local, server).map((e) => e.date)).toEqual([
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
    ]);
  });
  it("same-date collision → local value wins", () => {
    const out = mergeWeightLog([{ date: "2026-06-17", weightKg: 70 }], server);
    expect(out.find((e) => e.date === "2026-06-17")?.weightKg).toBe(70);
  });
  it("empty/null server must NOT wipe local weight entries", () => {
    expect(mergeWeightLog(local, null)).toHaveLength(2);
    expect(mergeWeightLog(local, [])).toHaveLength(2);
  });
});

// ─── profile ──────────────────────────────────────────────────────────────────

describe("mergeProfile", () => {
  it("local-only → kept when server is null", () => {
    const p = profile();
    expect(mergeProfile(p, null)).toBe(p);
  });
  it("server-only → adopted when no local", () => {
    const s = profile({ weightKg: 80 });
    expect(mergeProfile(null, s)).toEqual(s);
  });
  it("both → NEWER updatedAt wins", () => {
    const oldP = profile({ weightKg: 65, updatedAt: "2026-06-10T00:00:00.000Z" });
    const newP = profile({ weightKg: 70, updatedAt: "2026-06-19T00:00:00.000Z" });
    expect(mergeProfile(oldP, newP)?.weightKg).toBe(70);
    expect(mergeProfile(newP, oldP)?.weightKg).toBe(70);
  });
  it("null/invalid server must NOT wipe a local profile (#1 rule)", () => {
    const p = profile();
    expect(mergeProfile(p, null)).toBe(p);
    expect(mergeProfile(p, {})).toBe(p);
    expect(mergeProfile(p, { heightCm: "bad" })).toBe(p);
  });

  // Issue ③: the avatar now rides the synced profile blob as avatarDataUrl, so a
  // device that has it (newer profile) propagates the image to a device without.
  it("carries the synced avatar data URL across devices (newer wins)", () => {
    const withAvatar = profile({
      avatarDataUrl: "data:image/jpeg;base64,AVATAR",
      updatedAt: "2026-06-24T00:00:00.000Z",
    });
    const withoutAvatar = profile({ updatedAt: "2026-06-20T00:00:00.000Z" });
    // The device that set the avatar most recently wins → avatar propagates.
    expect(mergeProfile(withoutAvatar, withAvatar)?.avatarDataUrl).toBe(
      "data:image/jpeg;base64,AVATAR",
    );
    expect(mergeProfile(withAvatar, withoutAvatar)?.avatarDataUrl).toBe(
      "data:image/jpeg;base64,AVATAR",
    );
  });

  // Codex review (the reported bug): a NEWER profile edit whose payload omits the
  // avatar (e.g. a weight change) must NOT WIPE an avatar set on the other (older)
  // side. The avatar is preserved; other fields keep newer-wins (we do NOT broadly
  // resurrect cleared fields — that needs tombstones, scoped intentionally).
  it("a newer profile without an avatar does NOT drop the avatar set on the older side", () => {
    const olderWithAvatar = profile({
      avatarDataUrl: "data:image/jpeg;base64,KEEPME",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    const newerNoAvatar = profile({ weightKg: 72, updatedAt: "2026-06-24T00:00:00.000Z" });
    // Newer (server) wins core fields, but the older side's avatar is kept.
    const out = mergeProfile(olderWithAvatar, newerNoAvatar);
    expect(out?.weightKg).toBe(72); // newer core field won
    expect(out?.avatarDataUrl).toBe("data:image/jpeg;base64,KEEPME"); // avatar NOT wiped
    // Symmetric: newer LOCAL without avatar must not wipe the server's avatar either.
    const out2 = mergeProfile(newerNoAvatar, olderWithAvatar);
    expect(out2?.weightKg).toBe(72);
    expect(out2?.avatarDataUrl).toBe("data:image/jpeg;base64,KEEPME");
  });

  it("a newer profile WITH an avatar replaces the older avatar (newer-wins for the photo too)", () => {
    const older = profile({ avatarDataUrl: "data:image/jpeg;base64,OLD", updatedAt: "2026-06-20T00:00:00.000Z" });
    const newer = profile({ avatarDataUrl: "data:image/jpeg;base64,NEW", updatedAt: "2026-06-24T00:00:00.000Z" });
    expect(mergeProfile(older, newer)?.avatarDataUrl).toBe("data:image/jpeg;base64,NEW");
  });
});

// ─── coachSettings ──────────────────────────────────────────────────────────────

describe("mergeCoachSettings", () => {
  it("local-only / server-only", () => {
    expect(mergeCoachSettings({ name: "やさしい先生" }, null)).toMatchObject({ name: "やさしい先生" });
    expect(mergeCoachSettings({}, { name: "健康マン", style: "gentle" })).toMatchObject({
      name: "健康マン",
      style: "gentle",
    });
  });
  it("field-level union → name from one side + style from the other both survive", () => {
    const out = mergeCoachSettings({ name: "A" }, { style: "hardcore" });
    expect(out.name).toBe("A");
    expect(out.style).toBe("hardcore");
  });
  it("collision → local field wins (active device)", () => {
    const out = mergeCoachSettings({ name: "Local" }, { name: "Server" });
    expect(out.name).toBe("Local");
  });
  it("empty server must NOT clear a configured local persona", () => {
    const local: CoachSettings = { name: "やさしい先生", style: "gentle" };
    expect(mergeCoachSettings(local, {})).toMatchObject(local);
    expect(mergeCoachSettings(local, null)).toMatchObject(local);
  });
});

// ─── chat ──────────────────────────────────────────────────────────────────────

describe("mergeChat", () => {
  const local = [chat("a", "2026-06-19T08:00:00Z"), chat("c", "2026-06-19T10:00:00Z")];
  const server = [chat("b", "2026-06-19T09:00:00Z")];

  it("local-only / server-only", () => {
    expect(mergeChat(local, null).map((m) => m.id)).toEqual(["a", "c"]);
    expect(mergeChat([], server).map((m) => m.id)).toEqual(["b"]);
  });
  it("both present → union ordered by createdAt", () => {
    expect(mergeChat(local, server).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
  it("empty/null server must NOT wipe local chat", () => {
    expect(mergeChat(local, null)).toHaveLength(2);
    expect(mergeChat(local, [])).toHaveLength(2);
  });
});

// ─── apiToken (access key) ────────────────────────────────────────────────────

describe("mergeApiToken — durable access key, non-destructive newest-wins", () => {
  it("empty local (fresh/wiped device) → RESTORES the server's key", () => {
    const out = mergeApiToken(
      { token: "", updatedAt: "" },
      { token: "server-key", updatedAt: "2026-06-20T00:00:00Z" },
    );
    expect(out.token).toBe("server-key");
  });
  it("empty server → keeps the local key (an empty server can NEVER clear it)", () => {
    const out = mergeApiToken(
      { token: "local-key", updatedAt: "2026-06-20T00:00:00Z" },
      { token: "", updatedAt: "" },
    );
    expect(out.token).toBe("local-key");
  });
  it("both present → NEWER updatedAt wins", () => {
    const older = { token: "old-key", updatedAt: "2026-06-10T00:00:00Z" };
    const newer = { token: "new-key", updatedAt: "2026-06-20T00:00:00Z" };
    expect(mergeApiToken(older, newer).token).toBe("new-key");
    expect(mergeApiToken(newer, older).token).toBe("new-key");
  });
  it("tie / missing timestamps → keep local (active device)", () => {
    expect(mergeApiToken({ token: "L", updatedAt: "" }, { token: "S", updatedAt: "" }).token).toBe("L");
  });
  it("null/junk server must NOT wipe a local key", () => {
    expect(mergeApiToken({ token: "L", updatedAt: "t" }, null).token).toBe("L");
    expect(mergeApiToken({ token: "L", updatedAt: "t" }, { garbage: true }).token).toBe("L");
  });
});

describe("wouldShrinkSection — apiToken counts only a NON-EMPTY token", () => {
  it("restore (empty → key) is a GROWTH, never a shrink (must not be blocked)", () => {
    expect(
      wouldShrinkSection("apiToken", { token: "", updatedAt: "" }, { token: "k", updatedAt: "t" }),
    ).toBe(false);
  });
  it("a key disappearing WOULD be a shrink (guard would block an accidental wipe)", () => {
    expect(
      wouldShrinkSection("apiToken", { token: "k", updatedAt: "t" }, { token: "", updatedAt: "" }),
    ).toBe(true);
  });
  it("key → key (re-key) is not a shrink", () => {
    expect(
      wouldShrinkSection("apiToken", { token: "a", updatedAt: "t" }, { token: "b", updatedAt: "t2" }),
    ).toBe(false);
  });
});

// ─── applyTombstonesToSection — the delete exclusion that makes deletes stick ──

const DEL = (at = "2026-06-25T00:00:00Z") => ({ at, state: "deleted" as const });
const CLR = (at = "2026-06-25T00:00:00Z") => ({ at, state: "cleared" as const });

describe("applyTombstonesToSection", () => {
  it("drops tombstoned meal ids (a deleted meal is excluded from the union)", () => {
    const meals = [meal("1"), meal("2"), meal("3")];
    const dels = { meals: { "2": DEL() } };
    const out = applyTombstonesToSection("meals", meals, dels) as Meal[];
    expect(out.map((m) => m.id)).toEqual(["1", "3"]); // "2" removed
  });

  it("does NOT drop an id whose latest op is CLEARED (a re-add revived it)", () => {
    const meals = [meal("1"), meal("2")];
    const out = applyTombstonesToSection("meals", meals, { meals: { "2": CLR() } }) as Meal[];
    expect(out.map((m) => m.id)).toEqual(["1", "2"]); // "2" kept (revived)
  });

  it("drops a weightLog entry by DATE (the weightLog id is the date)", () => {
    const log = [
      { date: "2026-06-20", weightKg: 65 },
      { date: "2026-06-21", weightKg: 64 },
    ];
    const out = applyTombstonesToSection("weightLog", log, { weightLog: { "2026-06-20": DEL() } }) as WeightEntry[];
    expect(out.map((e) => e.date)).toEqual(["2026-06-21"]);
  });

  it("drops a tombstoned EXERCISE from a day; an emptied day is removed entirely", () => {
    const ex = (id: string) => ({ id, name: `e-${id}`, sets: 3, reps: 10, weight: 0 });
    const workouts = {
      "2026-06-24": { date: "2026-06-24", exercises: [ex("a"), ex("b")], updatedAt: "t" },
      "2026-06-25": { date: "2026-06-25", exercises: [ex("c")], updatedAt: "t" },
    };
    const out = applyTombstonesToSection("workouts", workouts, {
      workouts: { b: DEL(), c: DEL() },
    }) as Record<string, Workout>;
    // day 24 keeps exercise "a" (only "b" tombstoned); day 25 had only "c" → gone.
    expect(Object.keys(out)).toEqual(["2026-06-24"]);
    expect(out["2026-06-24"].exercises.map((e) => e.id)).toEqual(["a"]);
  });

  it("returns the value unchanged when there are no tombstones for the section", () => {
    const meals = [meal("1")];
    expect(applyTombstonesToSection("meals", meals, {})).toBe(meals);
    expect(applyTombstonesToSection("meals", meals, { chat: { x: DEL() } })).toBe(meals);
  });

  it("never filters the deletions/profile/coachSettings sections (no per-record id)", () => {
    const profile = { heightCm: 170, weightKg: 65 };
    expect(applyTombstonesToSection("profile", profile, { profile: { x: DEL() } } as never)).toBe(profile);
  });
});

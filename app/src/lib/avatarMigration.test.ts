import { afterEach, describe, it, expect, vi } from "vitest";

// compressAvatarToDataUrl uses canvas/createImageBitmap (browser-only). Mock it
// so the migration's ORCHESTRATION (read legacy blob → compress → write synced →
// drop legacy ref) is unit-testable in node. avatarStore.getAvatar is mocked to
// return a controllable blob (or null). storage load/save use the localStorage
// shim. pushSectionBestEffort is mocked to a spy.
const compressMock = vi.fn<(f: File) => Promise<string | null>>();
const getAvatarMock = vi.fn<(id: string) => Promise<Blob | null>>();
const pushSpy = vi.fn();

vi.mock("./image", () => ({
  compressAvatarToDataUrl: (f: File) => compressMock(f),
  // coachSettings.ts (pulled in via the coach migration) re-uses this const for
  // its data: URL size gate — expose it so the gate works under the mock.
  AVATAR_MAX_DATA_URL_CHARS: 180_000,
}));
vi.mock("./avatarStore", () => ({
  getAvatar: (id: string) => getAvatarMock(id),
}));
vi.mock("./syncData", () => ({
  pushSectionBestEffort: (section: string) => pushSpy(section),
}));

import { migrateLegacyAvatar, migrateLegacyCoachAvatar } from "./avatarMigration";
import type { Profile } from "./types";

const PROFILE_KEY = "health-app:profile:v1";
const COACH_KEY = "health-app:coachSettings";

function baseProfile(extra: Partial<Profile> = {}): Profile {
  return {
    heightCm: 170,
    weightKg: 65,
    age: 30,
    sex: "male",
    bodyType: "average",
    activityLevel: "moderate",
    goal: "maintain",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...extra,
  };
}

function installLocalStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    },
  });
  return map;
}

function storedProfile(map: Map<string, string>): Profile | null {
  const raw = map.get(PROFILE_KEY);
  return raw ? (JSON.parse(raw) as Profile) : null;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  compressMock.mockReset();
  getAvatarMock.mockReset();
  pushSpy.mockReset();
});

describe("migrateLegacyAvatar", () => {
  it("migrates a legacy IndexedDB avatar into the synced avatarDataUrl", async () => {
    const map = installLocalStorage({
      [PROFILE_KEY]: JSON.stringify(baseProfile({ avatarPhotoId: "avatar-legacy-1" })),
    });
    getAvatarMock.mockResolvedValue(new Blob(["img"], { type: "image/jpeg" }));
    compressMock.mockResolvedValue("data:image/jpeg;base64,AAAA");

    const did = await migrateLegacyAvatar("csrf-x");

    expect(did).toBe(true);
    const p = storedProfile(map)!;
    expect(p.avatarDataUrl).toBe("data:image/jpeg;base64,AAAA");
    expect(p.avatarPhotoId).toBeUndefined(); // dead legacy ref dropped
    expect(pushSpy).toHaveBeenCalledWith("profile");
  });

  it("is a no-op when the profile already has a synced avatarDataUrl (idempotent)", async () => {
    const map = installLocalStorage({
      [PROFILE_KEY]: JSON.stringify(
        baseProfile({ avatarDataUrl: "data:image/jpeg;base64,EXISTING", avatarPhotoId: "x" }),
      ),
    });
    const did = await migrateLegacyAvatar("csrf-x");
    expect(did).toBe(false);
    expect(getAvatarMock).not.toHaveBeenCalled();
    expect(storedProfile(map)!.avatarDataUrl).toBe("data:image/jpeg;base64,EXISTING");
  });

  it("is a no-op when there is no legacy ref at all", async () => {
    installLocalStorage({ [PROFILE_KEY]: JSON.stringify(baseProfile()) });
    const did = await migrateLegacyAvatar("csrf-x");
    expect(did).toBe(false);
    expect(getAvatarMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy ref (no destructive write) when the blob is gone", async () => {
    const map = installLocalStorage({
      [PROFILE_KEY]: JSON.stringify(baseProfile({ avatarPhotoId: "avatar-missing" })),
    });
    getAvatarMock.mockResolvedValue(null); // blob already removed on this device

    const did = await migrateLegacyAvatar("csrf-x");

    expect(did).toBe(false);
    // The legacy ref is preserved (we never wipe an avatar we couldn't migrate).
    expect(storedProfile(map)!.avatarPhotoId).toBe("avatar-missing");
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("keeps the legacy ref when compression fails / is over budget", async () => {
    const map = installLocalStorage({
      [PROFILE_KEY]: JSON.stringify(baseProfile({ avatarPhotoId: "avatar-big" })),
    });
    getAvatarMock.mockResolvedValue(new Blob(["img"], { type: "image/jpeg" }));
    compressMock.mockResolvedValue(null); // undecodable / too big

    const did = await migrateLegacyAvatar("csrf-x");

    expect(did).toBe(false);
    expect(storedProfile(map)!.avatarPhotoId).toBe("avatar-big");
    expect(storedProfile(map)!.avatarDataUrl).toBeUndefined();
  });

  it("is a no-op with no profile / on SSR and never throws", async () => {
    installLocalStorage(); // no profile stored
    await expect(migrateLegacyAvatar("csrf-x")).resolves.toBe(false);
    Reflect.deleteProperty(globalThis, "window");
    await expect(migrateLegacyAvatar("csrf-x")).resolves.toBe(false);
  });
});

function storedCoach(map: Map<string, string>): Record<string, unknown> | null {
  const raw = map.get(COACH_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe("migrateLegacyCoachAvatar", () => {
  it("migrates a legacy IndexedDB coach avatar into the synced avatarDataUrl", async () => {
    const map = installLocalStorage({
      [COACH_KEY]: JSON.stringify({ name: "せんせい", avatarPhotoId: "avatar-coach-1" }),
    });
    getAvatarMock.mockResolvedValue(new Blob(["img"], { type: "image/jpeg" }));
    compressMock.mockResolvedValue("data:image/jpeg;base64,COACHAAA");

    const did = await migrateLegacyCoachAvatar("csrf-x");

    expect(did).toBe(true);
    const c = storedCoach(map)!;
    expect(c.avatarDataUrl).toBe("data:image/jpeg;base64,COACHAAA");
    expect(c.avatarPhotoId).toBeUndefined(); // dead legacy ref dropped
    expect(c.name).toBe("せんせい"); // unrelated fields preserved
    expect(pushSpy).toHaveBeenCalledWith("coachSettings");
  });

  it("is a no-op when coach settings already have a synced avatarDataUrl", async () => {
    const map = installLocalStorage({
      [COACH_KEY]: JSON.stringify({
        avatarDataUrl: "data:image/jpeg;base64,EXISTINGCOACH",
        avatarPhotoId: "x",
      }),
    });
    const did = await migrateLegacyCoachAvatar("csrf-x");
    expect(did).toBe(false);
    expect(getAvatarMock).not.toHaveBeenCalled();
    expect(storedCoach(map)!.avatarDataUrl).toBe("data:image/jpeg;base64,EXISTINGCOACH");
  });

  it("is a no-op when there is no legacy coach ref at all", async () => {
    installLocalStorage({ [COACH_KEY]: JSON.stringify({ name: "せんせい" }) });
    const did = await migrateLegacyCoachAvatar("csrf-x");
    expect(did).toBe(false);
    expect(getAvatarMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy coach ref (no destructive write) when the blob is gone", async () => {
    const map = installLocalStorage({
      [COACH_KEY]: JSON.stringify({ avatarPhotoId: "avatar-coach-missing" }),
    });
    getAvatarMock.mockResolvedValue(null);

    const did = await migrateLegacyCoachAvatar("csrf-x");

    expect(did).toBe(false);
    expect(storedCoach(map)!.avatarPhotoId).toBe("avatar-coach-missing");
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("is a no-op with no settings / on SSR and never throws", async () => {
    installLocalStorage(); // no coach settings stored → loadCoachSettings → {}
    await expect(migrateLegacyCoachAvatar("csrf-x")).resolves.toBe(false);
    Reflect.deleteProperty(globalThis, "window");
    await expect(migrateLegacyCoachAvatar("csrf-x")).resolves.toBe(false);
  });
});

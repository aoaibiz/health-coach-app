import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { Profile } from "./types";

// storage.ts reads/writes window.localStorage (guarded for SSR). Shim a minimal
// localStorage on a window global so the round-trip + non-breaking migration are
// testable in the node environment (no DOM).
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

const PROFILE_KEY = "health-app:profile:v1";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    heightCm: 180,
    weightKg: 80,
    bodyType: "average",
    age: 30,
    sex: "male",
    activityLevel: "moderate",
    goal: "maintain",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("profile storage — name + avatar round-trip & non-breaking migration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  beforeEach(() => {
    vi.resetModules();
  });

  it("round-trips name + avatarPhotoId", async () => {
    installLocalStorage();
    const { saveProfile, loadProfile } = await import("./storage");
    const p = profile({ name: "Ao", avatarPhotoId: "avatar-123" });
    saveProfile(p);
    const loaded = loadProfile();
    expect(loaded?.name).toBe("Ao");
    expect(loaded?.avatarPhotoId).toBe("avatar-123");
    expect(loaded?.heightCm).toBe(180);
  });

  it("round-trips optional targetWeightKg (and omits it when unset)", async () => {
    installLocalStorage();
    const { saveProfile, loadProfile } = await import("./storage");
    saveProfile(profile({ targetWeightKg: 72 }));
    expect(loadProfile()?.targetWeightKg).toBe(72);
    saveProfile(profile()); // no target
    expect(loadProfile()?.targetWeightKg).toBeUndefined();
  });

  it("loads a pre-existing profile that has NO name/avatar fields (non-breaking)", async () => {
    // Exactly what an older client wrote: no `name`, no `avatarPhotoId`.
    const legacy = JSON.stringify({
      heightCm: 170,
      weightKg: 65,
      bodyType: "average",
      age: 28,
      sex: "female",
      activityLevel: "light",
      goal: "lose_fat",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    installLocalStorage({ [PROFILE_KEY]: legacy });
    const { loadProfile } = await import("./storage");
    const loaded = loadProfile();
    expect(loaded).not.toBeNull();
    expect(loaded?.heightCm).toBe(170);
    expect(loaded?.name).toBeUndefined();
    expect(loaded?.avatarPhotoId).toBeUndefined();
  });

  it("omits blank name/avatar as undefined (not empty string) is the caller's job; storage preserves what it's given", async () => {
    installLocalStorage();
    const { saveProfile, loadProfile } = await import("./storage");
    saveProfile(profile()); // no name / no avatar
    const loaded = loadProfile();
    expect(loaded?.name).toBeUndefined();
    expect(loaded?.avatarPhotoId).toBeUndefined();
  });
});

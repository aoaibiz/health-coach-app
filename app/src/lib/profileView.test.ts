import { describe, it, expect } from "vitest";
import {
  apiKeyStatus,
  apiKeyStatusLabel,
  avatarInitial,
  displayName,
  initialProfileMode,
  shouldReturnToViewAfterSave,
} from "./profileView";
import type { Profile } from "./types";

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

describe("apiKeyStatus — access-key status derivation (gap #3)", () => {
  it("treats null / undefined / empty / whitespace as unset", () => {
    expect(apiKeyStatus(null)).toBe("unset");
    expect(apiKeyStatus(undefined)).toBe("unset");
    expect(apiKeyStatus("")).toBe("unset");
    expect(apiKeyStatus("   ")).toBe("unset");
    expect(apiKeyStatus("\n\t")).toBe("unset");
  });

  it("treats any non-blank string as set", () => {
    expect(apiKeyStatus("secret")).toBe("set");
    expect(apiKeyStatus("  padded  ")).toBe("set");
    expect(apiKeyStatus("x")).toBe("set");
  });

  it("maps status to the user-facing label", () => {
    expect(apiKeyStatusLabel(apiKeyStatus("secret"))).toBe("設定済み ✓");
    expect(apiKeyStatusLabel(apiKeyStatus(""))).toBe("未設定");
  });
});

describe("initialProfileMode — view vs edit (gap #2)", () => {
  it("first run (no profile) starts in edit mode", () => {
    expect(initialProfileMode(null)).toBe("edit");
  });

  it("an existing profile starts in read-only view mode", () => {
    expect(initialProfileMode(profile())).toBe("view");
  });
});

describe("shouldReturnToViewAfterSave", () => {
  it("returns to view only when a profile already existed (edit)", () => {
    expect(shouldReturnToViewAfterSave(true)).toBe(true);
  });

  it("does not return to view on first-time setup (navigates to dashboard)", () => {
    expect(shouldReturnToViewAfterSave(false)).toBe(false);
  });
});

describe("displayName / avatarInitial", () => {
  it("uses the trimmed name when present", () => {
    expect(displayName(profile({ name: "  Ao  " }))).toBe("Ao");
    expect(displayName(profile({ name: "コルヴス" }))).toBe("コルヴス");
  });

  it("falls back when the name is missing or blank", () => {
    expect(displayName(profile({ name: undefined }))).toBe("あなた");
    expect(displayName(profile({ name: "   " }))).toBe("あなた");
    expect(displayName(profile())).toBe("あなた");
  });

  it("derives an avatar initial from the first character", () => {
    expect(avatarInitial(profile({ name: "Ao" }))).toBe("A");
    expect(avatarInitial(profile({ name: "コルヴス" }))).toBe("コ");
    expect(avatarInitial(profile({ name: undefined }))).toBe("あ");
  });
});

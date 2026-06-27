import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  API_TOKEN_UPDATED_AT_KEY,
  MAX_API_TOKEN_CHARS,
  loadApiTokenData,
  saveApiTokenData,
  sanitizeApiTokenData,
  sanitizeToken,
  setApiToken,
} from "./apiTokenStore";
import { API_TOKEN_STORAGE_KEY, hasApiKey } from "./analyzeMeal";

// A node-global window.localStorage shim (same pattern as analyzeMeal.test.ts).
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

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.useRealTimers();
});

describe("sanitizeToken", () => {
  it("trims, strips control chars, and clamps length", () => {
    expect(sanitizeToken("  secret-token  ")).toBe("secret-token");
    expect(sanitizeToken("ab\ncd\tef")).toBe("abcdef"); // control chars removed
    expect(sanitizeToken("x".repeat(MAX_API_TOKEN_CHARS + 50)).length).toBe(MAX_API_TOKEN_CHARS);
    expect(sanitizeToken(123)).toBe("");
    expect(sanitizeToken(null)).toBe("");
  });
});

describe("sanitizeApiTokenData", () => {
  it("normalises a raw blob into { token, updatedAt }", () => {
    expect(sanitizeApiTokenData({ token: "  k  ", updatedAt: "2026-06-24T00:00:00Z" })).toEqual({
      token: "k",
      updatedAt: "2026-06-24T00:00:00Z",
    });
  });
  it("tolerates junk / missing fields", () => {
    expect(sanitizeApiTokenData(null)).toEqual({ token: "", updatedAt: "" });
    expect(sanitizeApiTokenData("string")).toEqual({ token: "", updatedAt: "" });
    expect(sanitizeApiTokenData({ token: 42, updatedAt: 7 })).toEqual({ token: "", updatedAt: "" });
  });
});

describe("load/save round-trip via the ORIGINAL token key", () => {
  beforeEach(() => installLocalStorage());

  it("save writes the raw token to API_TOKEN_STORAGE_KEY so existing readers see it", () => {
    const map = installLocalStorage();
    saveApiTokenData({ token: "secret-token", updatedAt: "2026-06-24T00:00:00Z" });
    expect(map.get(API_TOKEN_STORAGE_KEY)).toBe("secret-token");
    expect(map.get(API_TOKEN_UPDATED_AT_KEY)).toBe("2026-06-24T00:00:00Z");
    // hasApiKey() (the existing reader) now sees the key.
    expect(hasApiKey()).toBe(true);
    // load reflects what was written.
    expect(loadApiTokenData()).toEqual({ token: "secret-token", updatedAt: "2026-06-24T00:00:00Z" });
  });

  it("saving a blank token REMOVES the original key (clear behaviour preserved)", () => {
    const map = installLocalStorage({ [API_TOKEN_STORAGE_KEY]: "old", [API_TOKEN_UPDATED_AT_KEY]: "t" });
    saveApiTokenData({ token: "", updatedAt: "" });
    expect(map.has(API_TOKEN_STORAGE_KEY)).toBe(false);
    expect(hasApiKey()).toBe(false);
  });

  it("load is SSR-safe (no window → empty envelope)", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(loadApiTokenData()).toEqual({ token: "", updatedAt: "" });
  });
});

describe("setApiToken — stamps updatedAt=now and persists", () => {
  it("writes the token + a fresh ISO updatedAt and keeps existing readers working", () => {
    const map = installLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const out = setApiToken("  my-key  ");
    expect(out.token).toBe("my-key");
    expect(out.updatedAt).toBe("2026-06-24T12:00:00.000Z");
    expect(map.get(API_TOKEN_STORAGE_KEY)).toBe("my-key");
    expect(hasApiKey()).toBe(true);
  });
});

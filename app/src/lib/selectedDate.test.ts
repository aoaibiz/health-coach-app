import { afterEach, describe, it, expect, vi } from "vitest";
import { toDateKey } from "./date";
import {
  SELECTED_DATE_KEY,
  isValidDateKey,
  loadSelectedDate,
  saveSelectedDate,
} from "./selectedDate";

// A tiny in-memory localStorage, stubbed onto `window` so the window-guarded
// storage seam runs under the node test env (mirrors avatarStore.test.ts's
// vi.stubGlobal approach — no new dependency, no jsdom).
function installFakeLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  vi.stubGlobal("window", { localStorage });
  return store;
}

describe("selectedDate — globally-shared date persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("isValidDateKey", () => {
    it("accepts a well-formed real calendar day", () => {
      expect(isValidDateKey("2026-06-18")).toBe(true);
      expect(isValidDateKey("2024-02-29")).toBe(true); // leap day
    });

    it("rejects malformed / impossible / non-string values", () => {
      expect(isValidDateKey("2026-13-01")).toBe(false); // bad month
      expect(isValidDateKey("2026-02-31")).toBe(false); // overflow day
      expect(isValidDateKey("2026-6-1")).toBe(false); // not zero-padded
      expect(isValidDateKey("garbage")).toBe(false);
      expect(isValidDateKey("")).toBe(false);
      expect(isValidDateKey(null)).toBe(false);
      expect(isValidDateKey(undefined)).toBe(false);
      expect(isValidDateKey(20260618)).toBe(false);
    });
  });

  describe("loadSelectedDate", () => {
    it("defaults to today when nothing is stored", () => {
      installFakeLocalStorage();
      expect(loadSelectedDate()).toBe(toDateKey());
    });

    it("returns the stored value when valid", () => {
      const store = installFakeLocalStorage();
      store.set(SELECTED_DATE_KEY, "2026-01-15");
      expect(loadSelectedDate()).toBe("2026-01-15");
    });

    it("falls back to today when the stored value is malformed", () => {
      const store = installFakeLocalStorage();
      store.set(SELECTED_DATE_KEY, "not-a-date");
      expect(loadSelectedDate()).toBe(toDateKey());
    });

    it("returns today on the server (no window — SSR/static-export safe)", () => {
      // No window stub installed for this case.
      vi.stubGlobal("window", undefined);
      expect(loadSelectedDate()).toBe(toDateKey());
    });
  });

  describe("saveSelectedDate + reload round-trip", () => {
    it("setting the date updates the shared stored value", () => {
      const store = installFakeLocalStorage();
      saveSelectedDate("2026-03-09");
      expect(store.get(SELECTED_DATE_KEY)).toBe("2026-03-09");
    });

    it("persists, so a reload (fresh load against the same storage) returns it", () => {
      const store = installFakeLocalStorage();
      saveSelectedDate("2026-03-09");

      // Simulate a reload: a brand-new client read against the same localStorage.
      vi.unstubAllGlobals();
      const reloaded = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
      };
      vi.stubGlobal("window", { localStorage: reloaded });

      expect(loadSelectedDate()).toBe("2026-03-09");
    });

    it("is a no-op on the server (no throw without window)", () => {
      vi.stubGlobal("window", undefined);
      expect(() => saveSelectedDate("2026-03-09")).not.toThrow();
    });
  });
});

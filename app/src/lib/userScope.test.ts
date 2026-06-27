import { afterEach, describe, it, expect, vi } from "vitest";
import {
  LAST_USER_ID_KEY,
  USER_DATA_KEYS,
  clearAllLocalData,
  clearLastUserId,
  getLastUserId,
  setLastUserId,
  userIdentityKey,
} from "./userScope";
import { API_TOKEN_STORAGE_KEY } from "./analyzeMeal";
import { API_TOKEN_UPDATED_AT_KEY } from "./apiTokenStore";
import { COACH_SETTINGS_KEY } from "./coachSettings";
import { WEIGHT_LOG_STORAGE_KEY } from "./weightLog";
import { CHAT_STORAGE_KEY } from "./chatStore";
import { SELECTED_DATE_KEY } from "./selectedDate";

// ── localStorage shim (same pattern as apiTokenStore.test.ts) ───────────────
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

// ── Minimal in-memory IndexedDB shim supporting open/clear/contains ─────────
function installFakeIndexedDB(seed: Record<string, unknown> = {}) {
  const photos = new Map<string, unknown>(Object.entries(seed));
  const stores = new Map<string, Map<string, unknown>>([["photos", photos]]);

  const indexedDB = {
    open: (_name: string, _version?: number) => {
      const req: {
        result?: unknown;
        error?: unknown;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
      } = {};
      const db = {
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        transaction: (_n: string, _mode?: string) => {
          const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void } = {};
          return {
            objectStore: (storeName: string) => ({
              clear: () => {
                stores.get(storeName)?.clear();
                queueMicrotask(() => tx.oncomplete?.());
              },
            }),
            get oncomplete() {
              return tx.oncomplete;
            },
            set oncomplete(fn: (() => void) | undefined) {
              tx.oncomplete = fn;
            },
            get onerror() {
              return tx.onerror;
            },
            set onerror(fn: (() => void) | undefined) {
              tx.onerror = fn;
            },
            get onabort() {
              return tx.onabort;
            },
            set onabort(fn: (() => void) | undefined) {
              tx.onabort = fn;
            },
          };
        },
        close: () => undefined,
      };
      req.result = db;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
  vi.stubGlobal("indexedDB", indexedDB);
  return { photos };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("userIdentityKey — robust to flat AND nested API shapes", () => {
  it("prefers a top-level id (flat shape / unit fixtures)", () => {
    expect(userIdentityKey({ id: "u1", email: "a@b.com" })).toBe("id:u1");
  });

  it("reads a nested user.id (LIVE backend shape {user:{id,email}})", () => {
    // The live API returns { user: { id, email }, csrfToken }; authApi leaves
    // state.user = { user: { id, email, ... } }. Must still resolve the id.
    expect(userIdentityKey({ user: { id: "u9", email: "x@y.com" } } as never)).toBe("id:u9");
  });

  it("falls back to email when no id (flat)", () => {
    expect(userIdentityKey({ email: "Foo@Bar.com" })).toBe("email:foo@bar.com");
  });

  it("falls back to nested email when no id present", () => {
    expect(userIdentityKey({ user: { email: "Foo@Bar.com" } } as never)).toBe(
      "email:foo@bar.com",
    );
  });

  it("returns '' for null/empty/identity-less users (treated as unknown)", () => {
    expect(userIdentityKey(null)).toBe("");
    expect(userIdentityKey(undefined)).toBe("");
    expect(userIdentityKey({} as never)).toBe("");
    expect(userIdentityKey({ id: "  " } as never)).toBe("");
  });

  it("distinguishes two different users (the whole point)", () => {
    const a = userIdentityKey({ user: { id: "aaa", email: "a@a.com" } } as never);
    const b = userIdentityKey({ user: { id: "bbb", email: "b@b.com" } } as never);
    expect(a).not.toBe(b);
  });
});

describe("lastUserId tracking", () => {
  it("set → get round-trips; clear removes it", () => {
    installLocalStorage();
    expect(getLastUserId()).toBeNull();
    setLastUserId("id:u1");
    expect(getLastUserId()).toBe("id:u1");
    clearLastUserId();
    expect(getLastUserId()).toBeNull();
  });

  it("setLastUserId('') is a no-op (never records an empty identity)", () => {
    installLocalStorage();
    setLastUserId("");
    expect(getLastUserId()).toBeNull();
  });

  it("getLastUserId is null on SSR (no window)", () => {
    expect(getLastUserId()).toBeNull();
  });
});

describe("USER_DATA_KEYS — completeness (clear-list can't silently drift)", () => {
  it("contains EVERY synced section key + sleep + selectedDate", () => {
    // If a new user-data localStorage key is added without listing it here, this
    // pins the regression: the clear would miss it and leak across users.
    const required = [
      "health-app:profile:v1",
      "health-app:meals:v1",
      "health-app:workouts:v1",
      WEIGHT_LOG_STORAGE_KEY,
      COACH_SETTINGS_KEY,
      CHAT_STORAGE_KEY,
      API_TOKEN_STORAGE_KEY,
      API_TOKEN_UPDATED_AT_KEY,
      "health-app:sleep:v1",
      SELECTED_DATE_KEY,
      // Delete tombstones are per-user data and MUST be cleared on a user switch.
      "health-app:deletions:v1",
    ];
    for (const k of required) expect(USER_DATA_KEYS).toContain(k);
  });

  it("does NOT include the theme preference or the lastUserId bookkeeping key", () => {
    expect(USER_DATA_KEYS).not.toContain("health-app:theme:v1");
    expect(USER_DATA_KEYS).not.toContain(LAST_USER_ID_KEY);
  });
});

describe("clearAllLocalData — wipes localStorage + IndexedDB photos", () => {
  it("removes every USER_DATA_KEY but preserves theme + lastUserId", async () => {
    const seed: Record<string, string> = {
      "health-app:theme:v1": "dark",
      [LAST_USER_ID_KEY]: "id:u1",
    };
    for (const k of USER_DATA_KEYS) seed[k] = "SECRET-USER-A-DATA";
    const map = installLocalStorage(seed);
    installFakeIndexedDB({ "avatar-1": new Blob(["x"]), "photo-2": new Blob(["y"]) });

    await clearAllLocalData();

    for (const k of USER_DATA_KEYS) {
      expect(map.has(k), `${k} should be cleared`).toBe(false);
    }
    // Preferences + bookkeeping survive (caller manages lastUserId explicitly).
    expect(map.get("health-app:theme:v1")).toBe("dark");
    expect(map.get(LAST_USER_ID_KEY)).toBe("id:u1");
  });

  it("clears the IndexedDB photos store (meal + avatar blobs)", async () => {
    installLocalStorage();
    const { photos } = installFakeIndexedDB({
      "avatar-1": new Blob(["a"]),
      "meal-photo-2": new Blob(["b"]),
    });
    expect(photos.size).toBe(2);
    await clearAllLocalData();
    expect(photos.size).toBe(0);
  });

  it("resolves (never throws) when IndexedDB is unavailable", async () => {
    installLocalStorage({ "health-app:meals:v1": "x" });
    // No indexedDB stubbed → the photo clear must resolve gracefully.
    vi.stubGlobal("indexedDB", undefined);
    await expect(clearAllLocalData()).resolves.toBeUndefined();
  });

  it("is a no-op on SSR (no window) and never throws", async () => {
    await expect(clearAllLocalData()).resolves.toBeUndefined();
  });
});

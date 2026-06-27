import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// ---- Minimal in-memory IndexedDB shim --------------------------------------
// No new dependency: a tiny key/value store that implements exactly the surface
// photoStore.ts uses (open → upgrade/success, transaction → objectStore →
// put/get/delete, oncomplete/onsuccess). Async callbacks fire on microtasks so
// the promise wrappers resolve naturally.

type Store = Map<string, unknown>;

function installFakeIndexedDB(): { stores: Map<string, Store> } {
  const stores = new Map<string, Store>();

  function makeRequest<T>(run: () => T) {
    const req: {
      result?: T;
      error?: unknown;
      onsuccess?: () => void;
      onerror?: () => void;
    } = {};
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (e) {
        req.error = e;
        req.onerror?.();
      }
    });
    return req;
  }

  function makeObjectStore(name: string) {
    const data = stores.get(name)!;
    return {
      put: (value: unknown, key: string) => makeRequest(() => void data.set(key, value)),
      get: (key: string) => makeRequest(() => data.get(key)),
      delete: (key: string) => makeRequest(() => void data.delete(key)),
    };
  }

  const indexedDB = {
    open: (_name: string, _version?: number) => {
      const req: {
        result?: unknown;
        error?: unknown;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        onerror?: () => void;
      } = {};
      const db = {
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        createObjectStore: (n: string) => {
          stores.set(n, new Map());
          return makeObjectStore(n);
        },
        transaction: (_n: string, _mode?: string) => {
          const tx: { oncomplete?: () => void; onerror?: () => void; error?: unknown } = {};
          return {
            objectStore: (storeName: string) => {
              const inner = makeObjectStore(storeName);
              // Fire tx.oncomplete after the operation's microtask settles.
              const wrap = <T>(op: () => { onsuccess?: () => void; onerror?: () => void; result?: T; error?: unknown }) => {
                const r = op();
                const onsuccess = r.onsuccess;
                r.onsuccess = () => {
                  onsuccess?.();
                  queueMicrotask(() => tx.oncomplete?.());
                };
                const onerror = r.onerror;
                r.onerror = () => {
                  onerror?.();
                  queueMicrotask(() => tx.onerror?.());
                };
                return r;
              };
              return {
                put: (v: unknown, k: string) => wrap(() => inner.put(v, k)),
                get: (k: string) => wrap(() => inner.get(k)),
                delete: (k: string) => wrap(() => inner.delete(k)),
              };
            },
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
          };
        },
        close: () => undefined,
      };
      req.result = db;
      queueMicrotask(() => {
        if (!stores.has("photos")) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  vi.stubGlobal("indexedDB", indexedDB);
  return { stores };
}

import {
  deleteAvatar,
  getAvatar,
  makeAvatarId,
  putAvatar,
  resolveAvatarUrl,
} from "./avatarStore";

describe("avatarStore — IndexedDB round-trip (gap #1)", () => {
  beforeEach(() => {
    installFakeIndexedDB();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makeAvatarId namespaces ids", () => {
    expect(makeAvatarId()).toMatch(/^avatar-/);
  });

  it("stores a blob and reads back the same bytes by the returned id", async () => {
    const blob = new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" });
    const id = await putAvatar(blob);
    expect(id).toMatch(/^avatar-/);

    const got = await getAvatar(id);
    expect(got).not.toBeNull();
    expect(got).toBe(blob);
  });

  it("returns null for a missing id", async () => {
    expect(await getAvatar("avatar-does-not-exist")).toBeNull();
  });

  it("deletes a stored avatar", async () => {
    const blob = new Blob(["x"], { type: "image/jpeg" });
    const id = await putAvatar(blob);
    expect(await getAvatar(id)).toBe(blob);

    await deleteAvatar(id);
    expect(await getAvatar(id)).toBeNull();
  });
});

// Issue ③: the avatar must follow the user across devices. New saves embed the
// image as a SYNCED data: URL on the profile; resolveAvatarUrl prefers it (no
// IndexedDB touch), falling back to the legacy device-local blob.
describe("resolveAvatarUrl — synced data URL preferred over legacy blob (issue ③)", () => {
  beforeEach(() => {
    installFakeIndexedDB();
    // resolveObjectURL is only needed for the legacy-blob branch.
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:fake-object-url",
      revokeObjectURL: () => undefined,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for a profile with no avatar", async () => {
    expect(await resolveAvatarUrl(null)).toBeNull();
    expect(await resolveAvatarUrl({})).toBeNull();
  });

  it("uses the synced data URL directly (no object URL to revoke)", async () => {
    const dataUrl = "data:image/jpeg;base64,AAAA";
    const res = await resolveAvatarUrl({ avatarDataUrl: dataUrl });
    expect(res).toEqual({ url: dataUrl, revoke: false });
  });

  it("prefers the synced data URL even when a legacy blob id is also present", async () => {
    const blob = new Blob(["legacy"], { type: "image/jpeg" });
    const id = await putAvatar(blob);
    const dataUrl = "data:image/jpeg;base64,BBBB";
    const res = await resolveAvatarUrl({ avatarDataUrl: dataUrl, avatarPhotoId: id });
    expect(res).toEqual({ url: dataUrl, revoke: false });
  });

  it("falls back to the legacy IndexedDB blob (object URL, revoke:true)", async () => {
    const blob = new Blob(["legacy"], { type: "image/jpeg" });
    const id = await putAvatar(blob);
    const res = await resolveAvatarUrl({ avatarPhotoId: id });
    expect(res).toEqual({ url: "blob:fake-object-url", revoke: true });
  });

  it("returns null when the legacy blob is gone (deleted/other device)", async () => {
    const res = await resolveAvatarUrl({ avatarPhotoId: "avatar-missing" });
    expect(res).toBeNull();
  });
});

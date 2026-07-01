import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAppServer, createMealImageJobStore } from "./index.mjs";
// Compiled (dist) MockProvider — NO network, NO codex CLI (PRD §8).
import { MockProvider } from "../dist/functions/_llm/mock.js";

// Spin up the real Node server on an ephemeral port and drive it over HTTP,
// injecting providers so the real `codex` CLI is NEVER spawned.
const TEST_TOKEN = "test-health-token";

/** Start a server with a given provider factory; returns base URL + closer.
 *  Defaults to an AUTHENTICATED session (verifySession → true) since most tests
 *  exercise route wiring, not auth; auth-specific tests override verifySession.
 *  (Codex audit S1: the AI routes now require a real ha_session, not a token.) */
function startServer(makeProvider, options = {}) {
  const server = createAppServer(makeProvider, {
    token: TEST_TOKEN,
    verifySession: () => true,
    ...options,
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function postJson(base, body, raw, token = TEST_TOKEN) {
  const headers = { "content-type": "application/json" };
  if (token) headers["X-Health-App-Token"] = token;
  return fetch(`${base}/api/analyze-meal`, {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

describe("Node server — POST /api/analyze-meal route wiring", () => {
  let srv;
  beforeAll(async () => {
    srv = await startServer(() => new MockProvider());
  });
  afterAll(async () => {
    if (srv) await srv.close();
  });

  it("valid text → 200 grounded JSON (DB-backed numbers, source present)", async () => {
    const res = await postJson(srv.base, { text: "ごはんと卵" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const data = await res.json();
    expect(data.matchedCount).toBeGreaterThanOrEqual(2);
    const matched = data.items.filter((i) => i.matched);
    expect(matched.length).toBeGreaterThanOrEqual(2);
    for (const it of matched) {
      expect(it.kcal).not.toBeNull();
      expect(it.source).toContain("日本食品標準成分表");
    }
    expect(data.totals.kcal).toBeGreaterThan(0);
    expect(data.generatedBy).toBe("MockProvider");
  });

  it("no image and no text → 400", async () => {
    const res = await postJson(srv.base, {});
    expect(res.status).toBe(400);
  });

  it("invalid JSON body → 400", async () => {
    const res = await postJson(srv.base, undefined, "{not json");
    expect(res.status).toBe(400);
  });

  it("non-POST → 405", async () => {
    const res = await fetch(`${srv.base}/api/analyze-meal`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("unmatched dish → 200 with honest nulls, no fabricated numbers", async () => {
    // Drive the MockProvider with a dish the DB cannot resolve.
    const local = await startServer(
      () => new MockProvider({ dishes: [{ name: "架空のごちそうZZZ", grams: 250 }] }),
    );
    try {
      const res = await postJson(local.base, { text: "なにか" });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.matchedCount).toBe(0);
      expect(data.items[0].matched).toBe(false);
      expect(data.items[0].kcal).toBeNull();
      expect(data.totals.kcal).toBe(0);
    } finally {
      await local.close();
    }
  });
});

describe("Node server — honest error mapping", () => {
  it("provider parse/timeout failure → 502 (never fabricates)", async () => {
    // A provider that throws a generic (non-CODEX_NOT_FOUND) error.
    const srv = await startServer(() => ({
      async analyzeMeal() {
        throw new Error("CODEX_TIMEOUT");
      },
    }));
    try {
      const res = await postJson(srv.base, { text: "ごはん" });
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toBeTruthy();
      expect(data.items).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("codex unavailable (CODEX_NOT_FOUND) → 503 analysis_unavailable", async () => {
    const srv = await startServer(() => ({
      async analyzeMeal() {
        throw new Error("CODEX_NOT_FOUND");
      },
    }));
    try {
      const res = await postJson(srv.base, { text: "ごはん" });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("analysis_unavailable");
      expect(data.message).toContain("手入力");
    } finally {
      await srv.close();
    }
  });
});

describe("Node server — analysis API hardening", () => {
  it("no valid login session → 401 before body handling (Codex audit S1)", async () => {
    // A token alone must NOT grant access; the route requires a verified ha_session.
    const srv = await startServer(() => new MockProvider(), { verifySession: () => false });
    try {
      const res = await postJson(srv.base, undefined, "x".repeat(10_000_000), TEST_TOKEN);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data).toEqual({ error: "unauthorized" });
    } finally {
      await srv.close();
    }
  });

  it("HEALTH_APP_TOKEN unset → 503 fail-closed", async () => {
    const srv = await startServer(() => new MockProvider(), { token: "" });
    try {
      const res = await postJson(srv.base, { text: "ごはん" }, undefined, TEST_TOKEN);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("analysis_unavailable");
      expect(data.message).toBe("写真解析は準備中です。");
    } finally {
      await srv.close();
    }
  });

  it("concurrency overflow → immediate 503 busy", async () => {
    let releaseFirst;
    let firstEntered;
    const firstEnteredPromise = new Promise((resolve) => {
      firstEntered = resolve;
    });
    const releaseFirstPromise = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const srv = await startServer(
      () => ({
        async analyzeMeal() {
          calls += 1;
          if (calls === 1) {
            firstEntered();
            await releaseFirstPromise;
          }
          return {
            dishes: [{ name: "ごはん", grams: 150, confidence: "high" }],
            generatedBy: "test",
          };
        },
      }),
      { maxConcurrency: 1 },
    );
    try {
      const first = postJson(srv.base, { text: "ごはん" });
      await firstEnteredPromise;
      const second = await postJson(srv.base, { text: "卵" });
      expect(second.status).toBe(503);
      const data = await second.json();
      expect(data.error).toBe("busy");
      releaseFirst();
      expect((await first).status).toBe(200);
    } finally {
      releaseFirst();
      await srv.close();
    }
  });
});

describe("Node server — static file serving + API isolation", () => {
  it("unknown /api/* path → 404 JSON", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/api/does-not-exist`);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      const data = await res.json();
      expect(data.error).toBe("Not found");
    } finally {
      await srv.close();
    }
  });

  it("missing static asset with extension → 404, not app-shell 200", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/_next/static/missing.js`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe("Not found");
    } finally {
      await srv.close();
    }
  });

  it("static html responses include security headers", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/profile/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    } finally {
      await srv.close();
    }
  });

  it("malformed URL escape → 400, not 500", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/%E0%A4%A`);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("Bad request");
    } finally {
      await srv.close();
    }
  });
});

// Codex audit S1: a logged-in user (the app is behind AuthGate) must not be asked
// for an access key. The server injects a NON-SECRET session-auth FLAG into the
// served HTML so the client unlocks AI automatically. The shared TOKEN is NEVER
// injected (a secret in public HTML was an auth-bypass + leak).
describe("Node server — session-auth flag injection into served HTML (Codex audit S1)", () => {
  it("injects window.__HEALTH_APP_SESSION_AUTH__=true and NEVER the token", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain(`window.__HEALTH_APP_SESSION_AUTH__=true`);
      // The shared token must NOT appear anywhere in the served HTML.
      expect(html).not.toContain("__HEALTH_APP_TOKEN__");
      expect(html).not.toContain(TEST_TOKEN);
      // The injection sits inside <head>, before the app code runs.
      const headIdx = html.search(/<head[^>]*>/i);
      expect(headIdx).toBeGreaterThanOrEqual(0);
      expect(html.indexOf("__HEALTH_APP_SESSION_AUTH__")).toBeGreaterThan(headIdx);
    } finally {
      await srv.close();
    }
  });

  it("injects the flag into a sub-page HTML too (e.g. /profile/), never the token", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/profile/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`window.__HEALTH_APP_SESSION_AUTH__=true`);
      expect(html).not.toContain("__HEALTH_APP_TOKEN__");
      expect(html).not.toContain(TEST_TOKEN);
    } finally {
      await srv.close();
    }
  });

  it("omits the flag when HEALTH_APP_TOKEN is unset (AI feature off → manual-key fallback)", async () => {
    const srv = await startServer(() => new MockProvider(), { token: "" });
    try {
      const res = await fetch(`${srv.base}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("__HEALTH_APP_SESSION_AUTH__");
      expect(html).not.toContain("__HEALTH_APP_TOKEN__");
    } finally {
      await srv.close();
    }
  });

  it("does NOT leak the token in the on-disk export NOR in the served HTML", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const onDisk = await readFile(join(here, "..", "out", "index.html"), "utf8");
    expect(onDisk).not.toContain("__HEALTH_APP_TOKEN__");
    expect(onDisk).not.toContain(TEST_TOKEN);
    // And the request-time served HTML never carries the token either.
    const srv = await startServer(() => new MockProvider());
    try {
      const served = await (await fetch(`${srv.base}/`)).text();
      expect(served).not.toContain("__HEALTH_APP_TOKEN__");
      expect(served).not.toContain(TEST_TOKEN);
    } finally {
      await srv.close();
    }
  });
});

// Issue ②: the served HTML navigation document must NOT be heuristically cached
// by the browser/CDN. Without a Cache-Control header browsers invent a freshness
// TTL and serve a STALE shell — keeping the OLD bundle refs AND skipping the
// request-time token injection, which is what surfaced "access-key screen on an
// already-logged-in session" / "deploys don't reach the user". Hashed assets
// (content-addressed) stay cacheable.
describe("Node server — HTML cache-control (issue ②: no stale shell)", () => {
  it("index HTML carries no-cache so a new deploy always reaches the user", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const cc = res.headers.get("cache-control") || "";
      expect(cc).toContain("no-cache");
      expect(cc).toContain("must-revalidate");
    } finally {
      await srv.close();
    }
  });

  it("sub-page HTML (e.g. /profile/) also carries no-cache", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/profile/`);
      expect(res.status).toBe(200);
      const cc = res.headers.get("cache-control") || "";
      expect(cc).toContain("no-cache");
      expect(cc).toContain("must-revalidate");
    } finally {
      await srv.close();
    }
  });

  it("the SPA fallback shell also carries no-cache", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      // An extensionless unknown route serves the app shell (client routing).
      const res = await fetch(`${srv.base}/some-client-route`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const cc = res.headers.get("cache-control") || "";
      expect(cc).toContain("no-cache");
    } finally {
      await srv.close();
    }
  });

  it("hashed static assets are NOT forced no-cache (immutable, content-addressed)", async () => {
    // Discover a REAL hashed asset from the export so this never hard-codes a
    // build-specific hash (which changes every `next build`).
    const { readdir } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const buildsDir = join(here, "..", "out", "_next", "static");
    const entries = await readdir(buildsDir, { withFileTypes: true });
    const buildDir = entries.find(
      (e) => e.isDirectory() && e.name !== "chunks" && e.name !== "css" && e.name !== "media",
    );
    if (!buildDir) return; // no build-hash dir in this export → nothing to assert.

    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/_next/static/${buildDir.name}/_buildManifest.js`);
      // Asset exists in the export → 200, JS, and NOT marked no-cache by us.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      const cc = res.headers.get("cache-control");
      // We only set cache-control on HTML + sw.js; a hashed asset has none from us.
      expect(cc === null || !cc.includes("no-cache")).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
async function postImageJson(base, body, raw, token = TEST_TOKEN) {
  const headers = { "content-type": "application/json" };
  if (token) headers["X-Health-App-Token"] = token;
  return fetch(`${base}/api/generate-meal-image`, {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

// Codex audit S1 (image path): meal-image generation ran user-controlled prompt
// text through a tool-capable Codex CLI with `--sandbox danger-full-access`, then
// read back the file path the model emitted — a prompt-injection could exfiltrate
// arbitrary HOST files. The route is now FAIL-CLOSED (always 503) so no user input
// ever reaches that path; the danger-full-access provider is never invoked.
describe("Node server - POST /api/generate-meal-image route is fail-closed (Codex audit S1)", () => {
  it("returns 503 image_generation_unavailable and NEVER invokes the image provider", async () => {
    let providerCalls = 0;
    const srv = await startServer(() => new MockProvider(), {
      makeImageProvider: () => ({
        async generateMealImage() {
          providerCalls += 1; // must never happen
          throw new Error("should not run");
        },
      }),
    });
    try {
      const res = await postImageJson(srv.base, { text: "鮭定食" });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("image_generation_unavailable");
      expect(providerCalls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it("is 503 even with a (now-ignored) token header — no body is read, no provider runs", async () => {
    const srv = await startServer(() => new MockProvider(), {
      makeImageProvider: () => ({
        async generateMealImage() {
          throw new Error("should not run");
        },
      }),
    });
    try {
      // A huge body would only matter if it were read; the route 503s first.
      const res = await postImageJson(srv.base, undefined, "x".repeat(10_000_000), TEST_TOKEN);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("image_generation_unavailable");
    } finally {
      await srv.close();
    }
  });

  it("non-POST → 405", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/api/generate-meal-image`, { method: "GET" });
      expect(res.status).toBe(405);
    } finally {
      await srv.close();
    }
  });

  it("the danger-full-access image runner read path is contained + PNG-validated (Codex audit S1c)", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../functions/_llm/codex.ts", import.meta.url),
      "utf8",
    );
    // Defense-in-depth in the provider itself: realpath-containment + PNG magic.
    expect(source).toContain("readGeneratedPngWithinDir");
    expect(source).toContain("PNG_MAGIC");
    expect(source).toContain("CODEX_IMAGE_PATH_OUTSIDE_TEMP");
  });
});

describe("createMealImageJobStore — async getOrStart (Codex audit S1 re-enable)", () => {
  it("returns pending while generating and the SAME meal does not start a second job", async () => {
    let resolveGen;
    const producer = () => new Promise((r) => {
      resolveGen = r;
    });
    const store = createMealImageJobStore({ maxConcurrent: 2 });
    expect(store.getOrStart("鮭定食", producer).status).toBe("pending");
    // Same key while in-flight → still pending; the second producer must NOT run.
    const second = store.getOrStart("鮭定食", () => {
      throw new Error("second producer should not run for an in-flight meal");
    });
    expect(second.status).toBe("pending");
    expect(store.pendingCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 0)); // let the deferred producer run
    resolveGen({ imageBase64: "abc", mimeType: "image/png", generatedBy: "x" });
  });

  it("becomes done (cached) after the generation resolves", async () => {
    let resolveGen;
    const store = createMealImageJobStore({ maxConcurrent: 2 });
    store.getOrStart("親子丼", () => new Promise((r) => {
      resolveGen = r;
    }));
    await new Promise((r) => setTimeout(r, 0)); // let the deferred producer run + assign resolveGen
    resolveGen({ imageBase64: "xyz", mimeType: "image/png", generatedBy: "x" });
    await new Promise((r) => setTimeout(r, 0)); // let the .then cache the result
    const done = store.getOrStart("親子丼", () => {
      throw new Error("producer should not run once cached");
    });
    expect(done.status).toBe("done");
    expect(done.data.imageBase64).toBe("xyz");
  });

  it("remembers a recent failure as error, then allows a retry after the error TTL", async () => {
    let t = 1000;
    const store = createMealImageJobStore({ maxConcurrent: 2, errorTtlMs: 100, now: () => t });
    store.getOrStart("boom", () => Promise.reject(new Error("gen failed")));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getOrStart("boom", () => {
      throw new Error("no retry while error is fresh");
    }).status).toBe("error");
    t += 200; // let the error entry expire
    expect(store.getOrStart("boom", () => new Promise(() => {})).status).toBe("pending");
  });

  it("returns busy when maxConcurrent background jobs are already running", () => {
    const store = createMealImageJobStore({ maxConcurrent: 1 });
    expect(store.getOrStart("a", () => new Promise(() => {})).status).toBe("pending");
    expect(store.getOrStart("b", () => new Promise(() => {})).status).toBe("busy");
  });
});

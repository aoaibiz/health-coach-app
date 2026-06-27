import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createAppServer } from "./index.mjs";
// Compiled (dist) MockProvider — NO network, NO codex CLI (PRD §8).
import { MockProvider } from "../dist/functions/_llm/mock.js";

// Spin up the real Node server on an ephemeral port and drive it over HTTP,
// injecting providers so the real `codex` CLI is NEVER spawned.
const TEST_TOKEN = "test-health-token";

/** Start a server with a given provider factory; returns base URL + closer. */
function startServer(makeProvider, options = {}) {
  const server = createAppServer(makeProvider, { token: TEST_TOKEN, ...options });
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
  it("missing/incorrect token → 401 before body handling", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await postJson(srv.base, undefined, "x".repeat(10_000_000), "");
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

// Issue ②: a logged-in user (the app is behind AuthGate) must not be asked for
// an access key. The server injects the shared token into the served HTML so the
// client unlocks AI automatically. The on-disk export stays token-free.
describe("Node server — access-token injection into served HTML (issue ②)", () => {
  it("injects window.__HEALTH_APP_TOKEN__ into the served index HTML", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain(`window.__HEALTH_APP_TOKEN__=`);
      expect(html).toContain(JSON.stringify(TEST_TOKEN));
      // The injection sits inside <head>, before the app code runs.
      const headIdx = html.search(/<head[^>]*>/i);
      expect(headIdx).toBeGreaterThanOrEqual(0);
      expect(html.indexOf("__HEALTH_APP_TOKEN__")).toBeGreaterThan(headIdx);
    } finally {
      await srv.close();
    }
  });

  it("injects the token into a sub-page HTML too (e.g. /profile/)", async () => {
    const srv = await startServer(() => new MockProvider());
    try {
      const res = await fetch(`${srv.base}/profile/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`window.__HEALTH_APP_TOKEN__=`);
      expect(html).toContain(JSON.stringify(TEST_TOKEN));
    } finally {
      await srv.close();
    }
  });

  it("omits the injection when HEALTH_APP_TOKEN is unset (manual-key fallback)", async () => {
    const srv = await startServer(() => new MockProvider(), { token: "" });
    try {
      const res = await fetch(`${srv.base}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("__HEALTH_APP_TOKEN__");
    } finally {
      await srv.close();
    }
  });

  it("does NOT modify the on-disk export (no token leak in the artifact)", async () => {
    // Read the static file directly; it must never contain the token.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const onDisk = await readFile(join(here, "..", "out", "index.html"), "utf8");
    expect(onDisk).not.toContain("__HEALTH_APP_TOKEN__");
    expect(onDisk).not.toContain(TEST_TOKEN);
  });

  it("escapes the token so it cannot break out of the <script> element", async () => {
    // A hostile token containing </script> must be neutralised (defense-in-depth;
    // the real token is opaque, but the escaping must hold regardless).
    const evil = `a</script><script>alert(1)</script>`;
    const srv = await startServer(() => new MockProvider(), { token: evil });
    try {
      const res = await fetch(`${srv.base}/`);
      const html = await res.text();
      // The raw closing tag from the token must NOT appear verbatim; it is
      // escaped to </script> inside the JS string literal.
      expect(html).not.toContain(`a</script><script>alert(1)</script>`);
      expect(html).toContain("\\u003c");
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

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Node server - POST /api/generate-meal-image route wiring", () => {
  it("missing/incorrect token -> 401 before body handling", async () => {
    const srv = await startServer(() => new MockProvider(), {
      makeImageProvider: () => ({
        async generateMealImage() {
          throw new Error("should not run");
        },
      }),
    });
    try {
      const res = await postImageJson(srv.base, undefined, "x".repeat(10_000_000), "");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    } finally {
      await srv.close();
    }
  });

  it("valid text -> 200 with injected fake image provider", async () => {
    let sawText = "";
    const srv = await startServer(() => new MockProvider(), {
      makeImageProvider: () => ({
        async generateMealImage(input) {
          sawText = input.text;
          return {
            imageBase64: Buffer.from("fake-png").toString("base64"),
            mimeType: "image/png",
            generatedBy: "fake-image-provider",
          };
        },
      }),
    });
    try {
      const res = await postImageJson(srv.base, { text: "鮭定食" });
      expect(res.status).toBe(200);
      expect(sawText).toBe("鮭定食");
      const data = await res.json();
      expect(data.mimeType).toBe("image/png");
      expect(data.imageBase64).toBe(Buffer.from("fake-png").toString("base64"));
      expect(data.generatedBy).toBe("fake-image-provider");
    } finally {
      await srv.close();
    }
  });

  it("coalesces concurrent same-text image requests into one provider job", async () => {
    let calls = 0;
    const started = deferred();
    const release = deferred();
    const srv = await startServer(() => new MockProvider(), {
      maxConcurrency: 1,
      makeImageProvider: () => ({
        async generateMealImage(input) {
          calls += 1;
          expect(input.text).toBe("鶏むね肉");
          started.resolve();
          await release.promise;
          return {
            imageBase64: Buffer.from("coalesced-png").toString("base64"),
            mimeType: "image/png",
            generatedBy: "fake-image-provider",
          };
        },
      }),
    });
    try {
      const first = postImageJson(srv.base, { text: "鶏むね肉" });
      await started.promise;
      const second = postImageJson(srv.base, { text: " 鶏むね肉 " });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toBe(1);
      release.resolve();

      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect((await a.json()).imageBase64).toBe(Buffer.from("coalesced-png").toString("base64"));
      expect((await b.json()).imageBase64).toBe(Buffer.from("coalesced-png").toString("base64"));
      expect(calls).toBe(1);
    } finally {
      release.resolve();
      await srv.close();
    }
  });

  it("serves a completed same-text retry from the short-lived image cache", async () => {
    let calls = 0;
    const srv = await startServer(() => new MockProvider(), {
      makeImageProvider: () => ({
        async generateMealImage() {
          calls += 1;
          return {
            imageBase64: Buffer.from(`cached-png-${calls}`).toString("base64"),
            mimeType: "image/png",
            generatedBy: "fake-image-provider",
          };
        },
      }),
    });
    try {
      const first = await postImageJson(srv.base, { text: "鮭定食" });
      const second = await postImageJson(srv.base, { text: " 鮭定食 " });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await first.json()).imageBase64).toBe(Buffer.from("cached-png-1").toString("base64"));
      expect((await second.json()).imageBase64).toBe(Buffer.from("cached-png-1").toString("base64"));
      expect(calls).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it("does not coalesce different long prompts that only share the first 200 characters", async () => {
    let calls = 0;
    const sharedPrefix = "x".repeat(210);
    const srv = await startServer(() => new MockProvider(), {
      makeImageProvider: () => ({
        async generateMealImage(input) {
          calls += 1;
          return {
            imageBase64: Buffer.from(`long-prompt-${input.text.endsWith("A") ? "a" : "b"}`).toString("base64"),
            mimeType: "image/png",
            generatedBy: "fake-image-provider",
          };
        },
      }),
    });
    try {
      const first = await postImageJson(srv.base, { text: `${sharedPrefix}A` });
      const second = await postImageJson(srv.base, { text: `${sharedPrefix}B` });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await first.json()).imageBase64).toBe(Buffer.from("long-prompt-a").toString("base64"));
      expect((await second.json()).imageBase64).toBe(Buffer.from("long-prompt-b").toString("base64"));
      expect(calls).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it("fake provider missing codex -> 503 image_generation_unavailable", async () => {
    const srv = await startServer(() => new MockProvider(), {
      makeImageProvider: () => ({
        async generateMealImage() {
          throw new Error("CODEX_NOT_FOUND");
        },
      }),
    });
    try {
      const res = await postImageJson(srv.base, { text: "ごはん" });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("image_generation_unavailable");
    } finally {
      await srv.close();
    }
  });

  it("fake provider timeout/parse failure -> 502 without image data", async () => {
    const srv = await startServer(() => new MockProvider(), {
      makeImageProvider: () => ({
        async generateMealImage() {
          throw new Error("CODEX_TIMEOUT");
        },
      }),
    });
    try {
      const res = await postImageJson(srv.base, { text: "ごはん" });
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.imageBase64).toBeUndefined();
      expect(data.error).toBeTruthy();
    } finally {
      await srv.close();
    }
  });

  it("real Codex image runner is configured with temp cwd and a longer timeout", async () => {
    const source = await (await import("node:fs/promises")).readFile(new URL("../functions/_llm/codex.ts", import.meta.url), "utf8");
    expect(source).toContain("const DEFAULT_TIMEOUT_MS = 120_000");
    expect(source).toContain('\"--cd\",');
    expect(source).toContain("cwd,");
  });
});

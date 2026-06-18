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
      const data = await res.json();
      expect(data.error).toBe("Not found");
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

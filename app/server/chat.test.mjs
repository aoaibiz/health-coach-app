import { describe, it, expect } from "vitest";
import { createAppServer } from "./index.mjs";
// Compiled (dist) MockChatProvider — NO network, NO codex CLI (PRD §8).
import { MockChatProvider } from "../dist/functions/_llm/chat-mock.js";

// Spin up the real Node server on an ephemeral port and drive POST /api/chat
// over HTTP, injecting providers so the real `codex` CLI is NEVER spawned.
const TEST_TOKEN = "test-health-token";

function startServer(options = {}) {
  const server = createAppServer(undefined, { token: TEST_TOKEN, ...options });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function postChat(base, body, raw, token = TEST_TOKEN) {
  const headers = { "content-type": "application/json" };
  if (token) headers["X-Health-App-Token"] = token;
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

describe("Node server — POST /api/chat route wiring", () => {
  it("valid message → 200 with the coach reply", async () => {
    const srv = await startServer({
      makeChatProvider: () => new MockChatProvider({ reply: "がんばろう！" }),
    });
    try {
      const res = await postChat(srv.base, {
        messages: [{ role: "user", content: "今日どう？" }],
        context: { goal: "減量", targetKcal: 1800 },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.reply).toBe("がんばろう！");
    } finally {
      await srv.close();
    }
  });

  it("empty messages → 400", async () => {
    const srv = await startServer({ makeChatProvider: () => new MockChatProvider() });
    try {
      const res = await postChat(srv.base, { messages: [] });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });

  it("invalid JSON body → 400", async () => {
    const srv = await startServer({ makeChatProvider: () => new MockChatProvider() });
    try {
      const res = await postChat(srv.base, undefined, "{not json");
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });

  it("non-POST → 405", async () => {
    const srv = await startServer({ makeChatProvider: () => new MockChatProvider() });
    try {
      const res = await fetch(`${srv.base}/api/chat`, { method: "GET" });
      expect(res.status).toBe(405);
    } finally {
      await srv.close();
    }
  });
});

describe("Node server — /api/chat auth + honest errors", () => {
  it("missing/incorrect token → 401 before processing", async () => {
    const srv = await startServer({ makeChatProvider: () => new MockChatProvider() });
    try {
      const res = await postChat(
        srv.base,
        { messages: [{ role: "user", content: "hi" }] },
        undefined,
        "",
      );
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data).toEqual({ error: "unauthorized" });
    } finally {
      await srv.close();
    }
  });

  it("HEALTH_APP_TOKEN unset → 503 fail-closed", async () => {
    const srv = await startServer({
      token: "",
      makeChatProvider: () => new MockChatProvider(),
    });
    try {
      const res = await postChat(
        srv.base,
        { messages: [{ role: "user", content: "hi" }] },
        undefined,
        TEST_TOKEN,
      );
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("chat_unavailable");
    } finally {
      await srv.close();
    }
  });

  it("provider failure → 502 (never fabricates a reply)", async () => {
    const srv = await startServer({
      makeChatProvider: () => new MockChatProvider({ throwError: true }),
    });
    try {
      const res = await postChat(srv.base, { messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toBeTruthy();
      expect(data.reply).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("codex unavailable (CODEX_NOT_FOUND) → 503 chat_unavailable", async () => {
    const srv = await startServer({
      makeChatProvider: () => ({
        async reply() {
          throw new Error("CODEX_NOT_FOUND");
        },
      }),
    });
    try {
      const res = await postChat(srv.base, { messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe("chat_unavailable");
    } finally {
      await srv.close();
    }
  });
});

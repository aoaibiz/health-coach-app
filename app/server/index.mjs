// Node backend server — the ACTIVE runtime for the health app (pivot away from
// Cloudflare Pages Functions + paid API). Zero new dependencies: plain node:http.
//
//   GET  /*                 → serve the static Next.js export from ../out
//   POST /api/analyze-meal  → CodexProvider (Codex CLI subscription, no API key)
//                             → existing pure handleAnalyzeMeal() → DB grounding
//
// The request/response contract is identical to the old CF function, so the
// client (src/lib/analyzeMeal.ts) is unchanged. Same origin → no CORS.
//
// Honest errors (never fabricate):
//   - codex binary missing / not logged in → 503 analysis_unavailable
//   - parse failure / timeout              → 502
//   - bad input                            → 400 / 413 (from handleAnalyzeMeal)
//
// This file imports the COMPILED handler/provider from ../dist (tsc output) so
// the .ts sources stay the single source of truth. Build with `npm run build:server`.

import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { timingSafeEqual } from "node:crypto";

import { handleAnalyzeMeal } from "../dist/functions/api/analyze-meal.js";
import { handleChat } from "../dist/functions/api/chat.js";
import { makeMealProvider, makeChatProvider } from "../dist/functions/_llm/select.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "out");
const PORT = Number(process.env.PORT) || 8787;
const DEFAULT_MAX_CONCURRENCY = 2;

/** ~9.5MB → comfortably above the 9MB base64 cap the handler enforces (413). */
const MAX_BODY_BYTES = 9_500_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// Baseline security headers emitted on every static response. Mirrored in
// public/_headers for a Cloudflare Pages deploy. CSP is intentionally NOT set
// here: the app injects an inline theme-init script in layout.tsx that would
// need a per-build hash/nonce; see the `# TODO CSP` note in public/_headers.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function configuredToken(options = {}) {
  return options.token ?? process.env.HEALTH_APP_TOKEN ?? "";
}

/**
 * Constant-time string equality for the x-health-app-token check, to avoid the
 * timing side-channel of a short-circuiting `!==`. Length check first (lengths
 * are not secret), then crypto.timingSafeEqual over the bytes (it requires equal
 * lengths). Behaviour is identical to `a === b` for the auth decision.
 */
function tokensMatch(provided, expected) {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function configuredMaxConcurrency(options = {}) {
  const raw = options.maxConcurrency ?? process.env.HEALTH_APP_MAX_CONCURRENCY;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENCY;
}

function createSemaphore(max) {
  let active = 0;
  return {
    acquire() {
      if (active >= max) return false;
      active += 1;
      return true;
    },
    release() {
      active = Math.max(0, active - 1);
    },
    active() {
      return active;
    },
  };
}

/** Read the full request body up to MAX_BODY_BYTES; reject (413) if larger. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(Object.assign(new Error("payload too large"), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
  });
}

/** Map a CodexProvider failure to an honest HTTP error. Never fabricates. */
function codexErrorResponse(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "CODEX_NOT_FOUND") {
    // Binary missing or not logged in → analysis unavailable, manual entry OK.
    return {
      status: 503,
      body: {
        error: "analysis_unavailable",
        message: "写真解析が今使えません。記録は手入力で保存できます。",
      },
    };
  }
  // Timeout or parse failure → upstream/processing error.
  return {
    status: 502,
    body: { error: "解析に失敗しました。あとで再試行できます。" },
  };
}

/**
 * Default provider factories — route through select.ts so the AI backend is env-
 * driven (AI_MODE/AI_PROVIDER). With AI_MODE unset / "local-codex" (the default),
 * this returns the subscription Codex providers exactly as before, so OUR / FAMILY
 * Node instances are UNCHANGED. A member self-host can set AI_MODE=own +
 * AI_PROVIDER=gemini + GEMINI_API_KEY to run on their own key instead.
 */
function defaultMakeProvider() {
  return makeMealProvider(process.env);
}

/** Default chat provider factory — env-driven via select.ts (default Codex). */
function defaultMakeChatProvider() {
  return makeChatProvider(process.env);
}

/**
 * The POST /api/analyze-meal route. Exported + given an injectable provider
 * factory so tests can drive it with a MockProvider (no CLI, no network) while
 * production uses CodexProvider. Returns the same contract as the old CF func.
 */
export async function handleAnalyzeMealRoute(
  req,
  res,
  makeProvider = defaultMakeProvider,
  options = {},
) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const token = configuredToken(options);
  if (!token) {
    sendJson(res, 503, {
      error: "analysis_unavailable",
      message: "写真解析は準備中です。",
    });
    return;
  }

  if (!tokensMatch(req.headers["x-health-app-token"], token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const semaphore = options.semaphore;
  const acquired = semaphore ? semaphore.acquire() : true;
  if (!acquired) {
    sendJson(res, 503, {
      error: "busy",
      message: "混み合っています。少し後でお試しください。",
    });
    return;
  }

  try {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err && err.tooLarge) {
        sendJson(res, 413, { error: "画像が大きすぎます" });
      } else {
        sendJson(res, 400, { error: "Invalid request body" });
      }
      return;
    }

    // Rebuild a WHATWG Request so we can reuse the pure, framework-free handler
    // verbatim (same validation, same grounding, same response shape).
    const request = new Request("http://localhost/api/analyze-meal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });

    // Wrap the provider so we can observe WHICH error it threw. The pure handler
    // swallows provider errors into a generic 502; this lets the route remap a
    // missing/unauthed codex binary to 503 WITHOUT touching the shared handler
    // and WITHOUT calling the provider twice. The wrapper never alters the result.
    const inner = makeProvider();
    let providerError = null;
    const provider = {
      async analyzeMeal(input) {
        try {
          return await inner.analyzeMeal(input);
        } catch (err) {
          providerError = err;
          throw err;
        }
      },
    };

    const result = await handleAnalyzeMeal(request, provider);

    // handleAnalyzeMeal returns 502 for ANY provider throw. If that throw was a
    // missing/unauthed codex binary, report 503 (analysis unavailable) instead.
    if (result.status === 502 && providerError) {
      const mapped = codexErrorResponse(providerError);
      sendJson(res, mapped.status, mapped.body);
      return;
    }

    const text = await result.text();
    res.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  } finally {
    if (semaphore) semaphore.release();
  }
}

/**
 * The POST /api/chat route. Token-gated + concurrency-capped IDENTICALLY to
 * /api/analyze-meal (fail-closed 503 when the token env is unset, 401 on
 * mismatch, shared semaphore). Injectable provider factory so tests drive it
 * with a MockChatProvider (no CLI, no network). Honest errors, never fabricates.
 */
export async function handleChatRoute(
  req,
  res,
  makeProvider = defaultMakeChatProvider,
  options = {},
) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const token = configuredToken(options);
  if (!token) {
    sendJson(res, 503, {
      error: "chat_unavailable",
      message: "チャットは準備中です。",
    });
    return;
  }

  if (!tokensMatch(req.headers["x-health-app-token"], token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const semaphore = options.semaphore;
  const acquired = semaphore ? semaphore.acquire() : true;
  if (!acquired) {
    sendJson(res, 503, {
      error: "busy",
      message: "混み合っています。少し後でお試しください。",
    });
    return;
  }

  try {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err && err.tooLarge) {
        sendJson(res, 413, { error: "リクエストが大きすぎます" });
      } else {
        sendJson(res, 400, { error: "Invalid request body" });
      }
      return;
    }

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });

    // Wrap the provider so we can observe WHICH error it threw and remap a
    // missing/unauthed codex binary to 503 WITHOUT touching the shared handler.
    const inner = makeProvider();
    let providerError = null;
    const provider = {
      async reply(input) {
        try {
          return await inner.reply(input);
        } catch (err) {
          providerError = err;
          throw err;
        }
      },
    };

    const result = await handleChat(request, provider);

    // handleChat returns 502 for ANY provider throw. If that throw was a
    // missing/unauthed codex binary, report 503 (chat unavailable) instead.
    if (result.status === 502 && providerError) {
      const msg =
        providerError instanceof Error ? providerError.message : String(providerError);
      if (msg === "CODEX_NOT_FOUND") {
        sendJson(res, 503, {
          error: "chat_unavailable",
          message: "チャットが今使えません。少し後でお試しください。",
        });
        return;
      }
    }

    const text = await result.text();
    res.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  } finally {
    if (semaphore) semaphore.release();
  }
}

/** Resolve a URL path to a file inside OUT_DIR, guarding against traversal. */
async function resolveStatic(urlPath) {
  // Strip query/hash; default to index.
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return { status: 400, message: "Bad request" };
  }
  if (p === "/" || p === "") p = "/index.html";

  // Prevent path traversal: normalize and ensure it stays under OUT_DIR.
  const candidate = normalize(join(OUT_DIR, p));
  if (candidate !== OUT_DIR && !candidate.startsWith(OUT_DIR + "/")) {
    return null;
  }

  // Try the path; if it's a directory or extensionless route, try index.html
  // (matches Next.js `trailingSlash: true` export → /dashboard/index.html).
  const tries = [];
  if (extname(candidate)) {
    tries.push(candidate);
  } else {
    tries.push(join(candidate, "index.html"));
    tries.push(candidate + ".html");
  }
  let realOutDir;
  try {
    realOutDir = await realpath(OUT_DIR);
  } catch {
    return null;
  }
  for (const file of tries) {
    try {
      const s = await stat(file);
      if (!s.isFile()) continue;
      const realFile = await realpath(file);
      if (realFile === realOutDir || realFile.startsWith(realOutDir + "/")) {
        return realFile;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function handleStatic(req, res) {
  const file = await resolveStatic(req.url || "/");
  if (file && typeof file === "object" && file.status === 400) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(file.message);
    return;
  }
  if (!file) {
    // SPA-ish fallback: serve the app shell so client routing can take over.
    try {
      const index = await resolveStatic("/");
      if (!index || typeof index !== "string") throw new Error("index not found");
      const buf = await readFile(index);
      res.writeHead(200, { "content-type": MIME[".html"], ...SECURITY_HEADERS });
      res.end(buf);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
    return;
  }
  try {
    const buf = await readFile(file);
    const headers = {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      ...SECURITY_HEADERS,
    };
    // The service worker must never be cached by the CDN/browser — a stale SW
    // keeps controlling the installed PWA and blocks push-handler updates.
    if (file.endsWith("/sw.js")) headers["cache-control"] = "no-cache, no-store, must-revalidate";
    res.writeHead(200, headers);
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

/**
 * Build the HTTP server. `makeProvider` is injectable so tests can wire a
 * MockProvider (no CLI/network); production uses the default CodexProvider.
 */
export function createAppServer(makeProvider = defaultMakeProvider, options = {}) {
  const semaphore = createSemaphore(configuredMaxConcurrency(options));
  const routeOptions = { ...options, semaphore };
  // Chat provider factory: injectable via options for tests (MockChatProvider);
  // production uses the default CodexChatProvider. Shares the same concurrency
  // semaphore + token as the analyze-meal route.
  const makeChatProvider = options.makeChatProvider ?? defaultMakeChatProvider;
  return createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/api/analyze-meal" || url.startsWith("/api/analyze-meal?")) {
      handleAnalyzeMealRoute(req, res, makeProvider, routeOptions).catch((err) => {
        // Last-resort honest failure; never fabricate.
        const mapped = codexErrorResponse(err);
        if (!res.headersSent) sendJson(res, mapped.status, mapped.body);
        else res.end();
      });
      return;
    }
    if (url === "/api/chat" || url.startsWith("/api/chat?")) {
      handleChatRoute(req, res, makeChatProvider, routeOptions).catch(() => {
        // Last-resort honest failure; never fabricate a reply.
        if (!res.headersSent) {
          sendJson(res, 502, { error: "返信を生成できませんでした。あとで再試行できます。" });
        } else {
          res.end();
        }
      });
      return;
    }
    if (url.startsWith("/api/")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    handleStatic(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Internal error");
    });
  });
}

export const server = createAppServer();

// Only listen when run directly (not when imported by tests).
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`health-app server listening on http://localhost:${PORT}`);
  });
}

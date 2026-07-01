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

import { handleAnalyzeMeal } from "../dist/functions/api/analyze-meal.js";
import { CodexProvider } from "../dist/functions/_llm/codex.js";
import { handleChat } from "../dist/functions/api/chat.js";
import { CodexChatProvider } from "../dist/functions/_llm/chat.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "out");
const PORT = Number(process.env.PORT) || 8787;
const DEFAULT_MAX_CONCURRENCY = 2;
const IMAGE_GENERATION_BUSY = "IMAGE_GENERATION_BUSY";
const MEAL_IMAGE_JOB_CACHE_TTL_MS = 15 * 60 * 1000;
const MEAL_IMAGE_JOB_CACHE_MAX_ENTRIES = 12;

/** ~9.5MB → comfortably above the 9MB base64 cap the handler enforces (413). */
const MAX_BODY_BYTES = 9_500_000;

/**
 * Cache-Control for HTML navigation documents (every route's index.html + the SPA
 * fallback). Without an explicit header browsers apply a HEURISTIC freshness
 * lifetime and may serve a STALE shell — keeping the old bundle refs AND skipping
 * the request-time token injection, which is what surfaced the "access-key screen
 * on an already-logged-in session" report. `no-cache` forces a revalidation on
 * every navigation (a 304 is cheap), so a deploy reaches users immediately.
 * Hashed assets (_next/static/...) are content-addressed and stay cacheable.
 */
const HTML_CACHE_CONTROL = "no-cache, must-revalidate";

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
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://health-coach-api.example.com",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join("; "),
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function withSecurityHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" }));
  res.end(body);
}

function configuredToken(options = {}) {
  return options.token ?? process.env.HEALTH_APP_TOKEN ?? "";
}

/** Origin of the API Worker that owns the login session store (ha_session → D1).
 *  The AI routes verify a caller's session by forwarding its Cookie header here. */
function healthApiOrigin(options = {}) {
  return (
    options.healthApiOrigin ??
    process.env.HEALTH_API_ORIGIN ??
    "https://health-coach-api.example.com"
  );
}

/**
 * Inject a NON-SECRET session-auth flag (`window.__HEALTH_APP_SESSION_AUTH__=true`)
 * so a logged-in user (the app is behind AuthGate) gets the AI features unlocked
 * with NO manual access-key entry.
 *
 * The shared access TOKEN is NO LONGER injected (Codex audit S1): putting a secret
 * into public HTML was both a leak and an auth-bypass (the token alone passed the
 * AI routes). The real authorization is the same-origin HttpOnly `ha_session`
 * cookie, verified server-side on every AI route (see hasValidSession). This flag
 * carries NOTHING secret — it is a literal `true`, so there is nothing to escape.
 *
 * Injected only when the AI feature is enabled (HEALTH_APP_TOKEN configured);
 * otherwise the HTML is served unchanged and the app falls back to the manual-key
 * path. Inserted right after <head> (allowed by the CSP). Returns the HTML
 * unchanged when there's no <head> or the feature is off.
 */
function injectSessionAuthFlag(html, enabled) {
  if (!enabled) return html;
  const snippet = `<script>window.__HEALTH_APP_SESSION_AUTH__=true;</script>`;
  // Insert after the first opening <head ...> tag.
  const m = html.match(/<head[^>]*>/i);
  if (!m) return html; // no head → leave untouched (manual-key fallback still works).
  const idx = m.index + m[0].length;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

/**
 * Verify the caller holds a real, server-validated login session (`ha_session`).
 * We cannot validate the cookie here — the D1 session store lives in the API
 * Worker — so we forward the request's Cookie header to the Worker's GET /auth/me
 * and trust ONLY a 200 (a resolved session). FAIL-CLOSED: a missing cookie, any
 * non-200, or a network error → unauthenticated. This REPLACES the old shared-token
 * gate (Codex audit S1: a token alone must NEVER grant access). `options.verifySession`
 * is a test seam; `options.healthApiOrigin` overrides the Worker origin.
 */
async function hasValidSession(req, options = {}) {
  if (typeof options.verifySession === "function") {
    return options.verifySession(req);
  }
  const cookie = req.headers["cookie"];
  // Fast reject (no network) when there is clearly no session cookie at all.
  if (!cookie || !/(?:^|;\s*)ha_session=/.test(cookie)) return false;
  try {
    const resp = await fetch(`${healthApiOrigin(options)}/auth/me`, {
      method: "GET",
      headers: { cookie },
    });
    return resp.status === 200;
  } catch {
    return false; // API Worker unreachable → fail closed (no access).
  }
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

function normalizeMealImageJobKey(text) {
  return text.trim().replace(/\s+/g, " ");
}

export function createMealImageJobStore(options = {}) {
  const ttlMs = options.ttlMs ?? MEAL_IMAGE_JOB_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? MEAL_IMAGE_JOB_CACHE_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  const cache = new Map();
  const inFlight = new Map();
  const errors = new Map();
  // Remember a recent failure briefly so a polling client sees "error" instead of
  // silently re-triggering another 2-minute generation on every poll.
  const errorTtlMs = options.errorTtlMs ?? 60_000;
  // Cap concurrent BACKGROUND generations (each is a slow codex process).
  const maxConcurrent = options.maxConcurrent ?? 2;

  function prune() {
    const current = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= current) cache.delete(key);
    }
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    // Bound the failure map too (Codex audit S1 re-enable): drop expired entries
    // and cap the size so many unique failing meal texts cannot grow memory.
    for (const [key, entry] of errors) {
      if (entry.expiresAt <= current) errors.delete(key);
    }
    while (errors.size > maxEntries) {
      const oldest = errors.keys().next().value;
      if (oldest === undefined) break;
      errors.delete(oldest);
    }
  }

  return {
    run(text, producer) {
      const key = normalizeMealImageJobKey(text);
      const current = now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > current) return Promise.resolve(cached.data);
      if (cached) cache.delete(key);

      const pending = inFlight.get(key);
      if (pending) return pending;

      const promise = Promise.resolve()
        .then(producer)
        .then((data) => {
          if (maxEntries > 0 && ttlMs > 0) {
            cache.set(key, { data, expiresAt: now() + ttlMs });
            prune();
          }
          return data;
        })
        .finally(() => {
          if (inFlight.get(key) === promise) inFlight.delete(key);
        });
      inFlight.set(key, promise);
      return promise;
    },
    // Non-blocking async job accessor (Codex audit S1 re-enable). NEVER awaits the
    // producer, so the HTTP request returns instantly and can never hit a gateway
    // timeout. Returns the current state; the client polls until "done"/"error".
    //   done    -> the cached image is ready
    //   pending -> a generation is running (or was just started here)
    //   error   -> the last attempt failed recently (retry after it expires)
    //   busy    -> too many generations in flight; try again shortly
    getOrStart(text, producer) {
      const key = normalizeMealImageJobKey(text);
      const current = now();

      const cached = cache.get(key);
      if (cached && cached.expiresAt > current) return { status: "done", data: cached.data };
      if (cached) cache.delete(key);

      const err = errors.get(key);
      if (err && err.expiresAt > current) return { status: "error", message: err.message };
      if (err) errors.delete(key);

      if (inFlight.has(key)) return { status: "pending" };
      if (inFlight.size >= maxConcurrent) return { status: "busy" };

      const promise = Promise.resolve()
        .then(producer)
        .then((data) => {
          if (maxEntries > 0 && ttlMs > 0) {
            cache.set(key, { data, expiresAt: now() + ttlMs });
            prune();
          }
        })
        .catch((e) => {
          errors.set(key, {
            message: (e && e.message) || "failed",
            expiresAt: now() + errorTtlMs,
          });
          prune();
        })
        .finally(() => {
          if (inFlight.get(key) === promise) inFlight.delete(key);
        });
      inFlight.set(key, promise);
      return { status: "pending" };
    },
    cachedCount() {
      prune();
      return cache.size;
    },
    pendingCount() {
      return inFlight.size;
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

/** Default provider factory — the ACTIVE path (real Codex CLI, no API key). */
function defaultMakeProvider() {
  return new CodexProvider();
}

/** Default chat provider factory — the ACTIVE path (real Codex CLI, no API key). */
function defaultMakeChatProvider() {
  return new CodexChatProvider();
}

/** Default image provider factory - Codex CLI subscription + image_generation. */
function defaultMakeImageProvider() {
  return new CodexProvider();
}

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

  // AUTH (Codex audit S1): require a real, server-verified login session
  // (ha_session) — NOT a shared token. The session cookie is same-origin, so it
  // travels automatically; we verify it against the API Worker. Fail-closed.
  if (!(await hasValidSession(req, options))) {
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

    const request = new Request("http://localhost/api/analyze-meal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });

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
    if (result.status === 502 && providerError) {
      const mapped = codexErrorResponse(providerError);
      sendJson(res, mapped.status, mapped.body);
      return;
    }

    const text = await result.text();
    res.writeHead(result.status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" }));
    res.end(text);
  } finally {
    if (semaphore) semaphore.release();
  }
}

export async function handleGenerateMealImageRoute(
  req,
  res,
  // eslint-disable-next-line no-unused-vars
  makeProvider = defaultMakeImageProvider,
  // eslint-disable-next-line no-unused-vars
  options = {},
) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  // Feature gate: the securely-rebuilt image path stays OFF (clean 503) until it
  // has been verified end-to-end and independently reviewed. Flip
  // HEALTH_MEAL_IMAGE_ENABLED=1 in the service env to enable.
  if (String(process.env.HEALTH_MEAL_IMAGE_ENABLED || "").trim() !== "1") {
    sendJson(res, 503, {
      error: "image_generation_unavailable",
      message: "画像生成は現在ご利用いただけません。",
    });
    return;
  }

  const token = configuredToken(options);
  if (!token) {
    sendJson(res, 503, {
      error: "image_generation_unavailable",
      message: "画像生成は現在ご利用いただけません。",
    });
    return;
  }

  // AUTH (Codex audit S1): require a real, server-verified login session
  // (ha_session) — NOT a shared token. Fail-closed.
  if (!(await hasValidSession(req, options))) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

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

  let body;
  try {
    body = JSON.parse((raw && raw.toString ? raw.toString("utf8") : String(raw)) || "{}");
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }
  const text = typeof body.text === "string" ? body.text : "";
  const itemNames = Array.isArray(body.itemNames)
    ? body.itemNames.filter((s) => typeof s === "string")
    : undefined;
  if (!text.trim() && !(itemNames && itemNames.length)) {
    sendJson(res, 400, { error: "meal text required" });
    return;
  }

  // ASYNC generation (Codex audit S1 RE-ENABLE). NEVER block the request on the
  // ~2-minute generation — a synchronous wait 524s at the Cloudflare gateway.
  // Instead kick the job off in the background via the job store and return the
  // current state instantly; the client polls this same endpoint until "done".
  // The provider runs Codex image_gen in a workspace-write jail (NO
  // danger-full-access), SANITISES the untrusted meal text to a food subject, and
  // reads back ONLY a PNG contained in the per-call temp dir (containment +
  // PNG-magic + size). The store caps concurrent background jobs + remembers a
  // recent failure so a poll sees "error" instead of silently restarting.
  const jobs = options.imageJobs;
  if (!jobs || typeof jobs.getOrStart !== "function") {
    sendJson(res, 503, {
      error: "image_generation_unavailable",
      message: "画像生成は現在ご利用いただけません。",
    });
    return;
  }
  const provider = makeProvider();
  const subjectText = text || (itemNames ? itemNames.join(" / ") : "");
  const state = jobs.getOrStart(subjectText, () =>
    provider.generateMealImage({ text, itemNames }),
  );

  if (state.status === "done") {
    sendJson(res, 200, {
      status: "done",
      imageBase64: state.data.imageBase64,
      mimeType: state.data.mimeType,
      generatedBy: state.data.generatedBy,
    });
    return;
  }
  if (state.status === "error") {
    sendJson(res, 200, {
      status: "error",
      message: "画像生成に失敗しました。少し時間をおいて再試行できます。",
    });
    return;
  }
  // pending or busy — the client should keep polling.
  sendJson(res, 200, {
    status: "pending",
    message:
      state.status === "busy"
        ? "混み合っています。生成の順番を待っています…"
        : "画像を生成しています（最大2〜3分）…",
  });
}

function chatErrorResponse(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "CODEX_NOT_FOUND") {
    return {
      status: 503,
      body: {
        error: "chat_unavailable",
        message: "チャット返信が今使えません。あとで再試行できます。",
      },
    };
  }
  return {
    status: 502,
    body: { error: "返信を生成できませんでした。あとで再試行できます。" },
  };
}

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
      message: "チャット返信は準備中です。",
    });
    return;
  }

  // AUTH (Codex audit S1): require a real, server-verified login session
  // (ha_session) — NOT a shared token. Same-origin cookie is verified against the
  // API Worker. Fail-closed.
  if (!(await hasValidSession(req, options))) {
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
      sendJson(res, err && err.tooLarge ? 413 : 400, {
        error: err && err.tooLarge ? "リクエストが大きすぎます" : "Invalid request body",
      });
      return;
    }

    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });

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
    if (result.status === 502 && providerError) {
      const mapped = chatErrorResponse(providerError);
      sendJson(res, mapped.status, mapped.body);
      return;
    }

    const text = await result.text();
    res.writeHead(result.status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" }));
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

async function handleStatic(req, res, options = {}) {
  const requestPath = req.url || "/";
  // AI is enabled when HEALTH_APP_TOKEN is configured; we inject only a NON-SECRET
  // session-auth flag (never the token itself — Codex audit S1).
  const aiEnabled = !!configuredToken(options);
  const file = await resolveStatic(requestPath);
  if (file && typeof file === "object" && file.status === 400) {
    res.writeHead(400, withSecurityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end(file.message);
    return;
  }
  if (!file) {
    let decodedPath = "";
    try {
      decodedPath = decodeURIComponent(requestPath.split("?")[0].split("#")[0]);
    } catch {
      res.writeHead(400, withSecurityHeaders({ "content-type": "text/plain; charset=utf-8" }));
      res.end("Bad request");
      return;
    }
    if (extname(decodedPath)) {
      res.writeHead(404, withSecurityHeaders({ "content-type": "text/plain; charset=utf-8" }));
      res.end("Not found");
      return;
    }
    // SPA-ish fallback: serve the app shell so client routing can take over.
    try {
      const index = await resolveStatic("/");
      if (!index || typeof index !== "string") throw new Error("index not found");
      const buf = await readFile(index);
      // Inject the NON-SECRET session-auth flag (request-time) so a logged-in user
      // gets the AI features without manually entering an access key. The shared
      // token is never injected (Codex audit S1).
      const html = injectSessionAuthFlag(buf.toString("utf8"), aiEnabled);
      // HTML must NOT be heuristically cached by the browser/CDN (no Cache-Control
      // → browsers guess a TTL and serve a STALE shell, so a deploy's new bundle
      // refs + the request-time injection never reach the user; this is what
      // surfaced the "access-key screen on a logged-in session" report). Hashed
      // assets under _next/static stay immutable; only the navigation document is
      // marked always-revalidate.
      res.writeHead(200, withSecurityHeaders({ "content-type": MIME[".html"], "cache-control": HTML_CACHE_CONTROL }));
      res.end(html);
    } catch {
      res.writeHead(404, withSecurityHeaders({ "content-type": "text/plain; charset=utf-8" }));
      res.end("Not found");
    }
    return;
  }
  try {
    const buf = await readFile(file);
    const headers = withSecurityHeaders({ "content-type": MIME[extname(file)] || "application/octet-stream" });
    // The service worker must never be cached by the CDN/browser — a stale SW
    // keeps controlling the installed PWA and blocks push-handler updates.
    if (file.endsWith("/sw.js")) headers["cache-control"] = "no-cache, no-store, must-revalidate";
    // HTML pages (every route serves <route>/index.html): inject the NON-SECRET
    // session-auth flag at request time so a logged-in user gets the AI features
    // with no manual key entry. The shared token is never injected (Codex audit S1).
    if (file.endsWith(".html")) {
      // Always-revalidate the navigation document (see HTML_CACHE_CONTROL): a
      // stale cached shell is exactly what made a logged-in user see the old
      // access-key screen and never receive a newly-deployed bundle.
      headers["cache-control"] = HTML_CACHE_CONTROL;
      const html = injectSessionAuthFlag(buf.toString("utf8"), aiEnabled);
      res.writeHead(200, headers);
      res.end(html);
      return;
    }
    res.writeHead(200, headers);
    res.end(buf);
  } catch {
    res.writeHead(404, withSecurityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end("Not found");
  }
}

/**
 * Build the HTTP server. `makeProvider` is injectable so tests can wire a
 * MockProvider (no CLI/network); production uses the default CodexProvider.
 */
export function createAppServer(makeProvider = defaultMakeProvider, options = {}) {
  const semaphore = createSemaphore(configuredMaxConcurrency(options));
  const imageJobs = options.imageJobs ?? createMealImageJobStore(options.imageJobStoreOptions);
  const routeOptions = { ...options, semaphore, imageJobs };
  // Chat provider factory: injectable via options for tests (MockChatProvider);
  // production uses the default CodexChatProvider. Shares the same concurrency
  // semaphore + token as the analyze-meal route.
  const makeChatProvider = options.makeChatProvider ?? defaultMakeChatProvider;
  const makeImageProvider = options.makeImageProvider ?? defaultMakeImageProvider;
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
    if (url === "/api/generate-meal-image" || url.startsWith("/api/generate-meal-image?")) {
      handleGenerateMealImageRoute(req, res, makeImageProvider, routeOptions).catch(() => {
        if (!res.headersSent) sendJson(res, 502, { error: "画像生成に失敗しました。あとで再試行できます。" });
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
    handleStatic(req, res, routeOptions).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, withSecurityHeaders({ "content-type": "text/plain; charset=utf-8" }));
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

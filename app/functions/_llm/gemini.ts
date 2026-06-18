// GeminiProvider / GeminiChatProvider — the "own-key" meal-vision + chat
// adapters for the Google Gemini API.
//
// WHY THIS EXISTS: the DEFAULT runtime path is the subscription Codex CLI
// (functions/_llm/codex.ts, functions/_llm/chat.ts) which needs NO API key and
// powers our/family instances. But a MEMBER who self-hosts their own deploy of
// this OSS app has no Codex subscription — so they bring THEIR OWN AI key. This
// provider lets a member's deploy run meal-photo analysis + the coach chat on
// the member's own Google Gemini key (default: the FREE Gemini Flash tier). One
// env flag (AI_MODE=own + AI_PROVIDER=gemini, see ./select.ts) selects it; our
// instances stay on Codex untouched.
//
// CONTRACT (identical to CodexProvider — anti-fabrication, PRD §3.3): the model
// only IDENTIFIES dishes (name + grams + source + confidence). For source="db"
// it returns name + grams ONLY; the bundled MEXT DB (functions/_lib/ground.ts)
// supplies the authoritative numbers downstream. For "label"/"estimate" it ALSO
// returns the kcal/PFC for that grams (transcribed label / general-knowledge
// estimate). We REUSE the exact same prompt + the exact same robust JSON parser
// as the Codex path (imported from the Node-free ./meal-extract module, which
// ./codex re-exports), so the dish schema, the "last JSON block wins" behaviour,
// and the no-fabrication coercion are byte-identical.
//
// Chat: the prompt is built by the SAME chat-prompt.ts as the Codex path, so the
// persona / guardrails / grounding context are identical. Only the transport
// changes (Gemini contents instead of a codex subprocess).
//
// RUNTIME: fetch-native (no Node-only APIs), so the same code runs under the
// Cloudflare Pages Functions runtime that a member's deploy uses AND under Node.
//
// SECURITY: GEMINI_API_KEY is read from the runtime env ONLY (never hardcoded,
// never logged). The image bytes / conversation are never logged. Errors surface
// only the HTTP status, never the key. The image(s) are untrusted input but here
// they are just inline_data bytes to a hosted API (no local shell), and the
// prompt instructs the model to ignore any embedded commands and output only the
// requested JSON — same framing as the Codex meal prompt.

// Reuse the EXACT same meal prompt + robust JSON parser as the Codex path, but
// import them from the Node-FREE module (./meal-extract) rather than ./codex —
// importing from ./codex would pull node:child_process / node:fs into this file
// and break a member's Cloudflare Pages (Workers) bundle. The prompt + parser are
// byte-identical (./codex re-exports the same symbols), so the contract is unchanged.
import { MEAL_PROMPT, extractDishesFromCodexOutput } from "./meal-extract";
import type { AnalyzeInput, AnalyzeResult, MealVisionProvider } from "./provider";
import type { ChatProvider } from "./chat";
import { buildChatPrompt, type ChatContext, type ChatTurn } from "./chat-prompt";
import type { IdentifiedDish } from "../_lib/ground";

const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Default models. Gemini's free tier exposes a multimodal Flash model; we pick a
 * current, free-tier Flash id and make BOTH the meal-vision and chat model
 * env-overridable (MEAL_VISION_MODEL / CHAT_MODEL). NOTE: Google revises model
 * ids over time — a self-hoster should double-check the current free-tier Flash
 * id (e.g. on Google AI Studio) and override via env if needed.
 */
const DEFAULT_MEAL_MODEL = "gemini-2.0-flash";
const DEFAULT_CHAT_MODEL = "gemini-2.0-flash";

/** Default per-call timeout (ms). Vision can be slow; on timeout we throw. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Generated-by label surfaced in the UI for transparency. */
function mealGeneratedBy(model: string): string {
  return `gemini (${model})`;
}

/** Image mime sent inline. The client downsizes uploads to JPEG (see codex.ts). */
const IMAGE_MIME = "image/jpeg";

// ---- Gemini request/response shapes (the subset we use) --------------------
// Snake_case for inline_data / mime_type (the API accepts snake_case here; the
// rest of the body — generationConfig / systemInstruction — is camelCase per the
// REST schema). Kept as plain interfaces so the body construction is pure +
// unit-testable without a live key.

interface GeminiInlineData {
  inline_data: { mime_type: string; data: string };
}
interface GeminiTextPart {
  text: string;
}
type GeminiPart = GeminiTextPart | GeminiInlineData;

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiGenerateContentBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string } };
  generationConfig?: {
    responseMimeType?: string;
    temperature?: number;
    maxOutputTokens?: number;
  };
}

/** The slice of the Gemini response we read: candidates[].content.parts[].text. */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
  }>;
}

/** Collapse a meal's single/multi image inputs into ONE ordered, non-empty list
 *  (multi takes precedence; lone single is the 1-element case) — mirrors the
 *  Codex provider's normalisation so behaviour is identical across providers. */
export function collectMealImages(input: AnalyzeInput): string[] {
  return (
    input.imageBase64List && input.imageBase64List.length > 0
      ? input.imageBase64List
      : input.imageBase64
        ? [input.imageBase64]
        : []
  ).filter((b) => typeof b === "string" && b.length > 0);
}

/**
 * Build the Gemini generateContent body for a meal analysis. PURE (no network) so
 * it's unit-testable: every image becomes an inline_data part, the optional text
 * hint is appended (our own server text, treated as a hint), the shared MEAL
 * prompt is the systemInstruction, and responseMimeType=application/json nudges
 * the model toward a clean JSON object (we still parse robustly). The dish schema
 * the model must emit is defined by MEAL_PROMPT (reused from the Codex path).
 */
export function buildMealRequestBody(
  images: string[],
  text: string | undefined,
): GeminiGenerateContentBody {
  const parts: GeminiPart[] = [];
  for (const data of images) {
    parts.push({ inline_data: { mime_type: IMAGE_MIME, data } });
  }
  // A short user turn referencing the (system-instruction) schema; the optional
  // text is appended as a hint only, exactly like the Codex meal path.
  const userText = text
    ? `この食事を上記の形式のJSONで報告してください。参考の説明文: ${text}`
    : "この写真の食事を上記の形式のJSONで報告してください。";
  parts.push({ text: userText });

  return {
    contents: [{ role: "user", parts }],
    systemInstruction: { parts: { text: MEAL_PROMPT } },
    // Ask for JSON so the model returns the object cleanly; we still scan for the
    // last valid JSON block (extractDishesFromCodexOutput) to be robust.
    generationConfig: { responseMimeType: "application/json" },
  };
}

/**
 * Map a recent chat transcript into Gemini `contents`. PURE + exported for tests.
 * The full persona / guardrail / grounding prompt (built by chat-prompt.ts) is
 * passed as the systemInstruction so it's IDENTICAL to the Codex path; the
 * conversation turns become user/model contents (assistant → "model"). The last
 * turn is the user's current message we're replying to.
 */
export function buildChatRequestBody(
  messages: ChatTurn[],
  context: ChatContext | undefined,
): GeminiGenerateContentBody {
  const systemPrompt = buildChatPrompt(messages, context);
  const contents: GeminiContent[] = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  return {
    contents,
    systemInstruction: { parts: { text: systemPrompt } },
  };
}

/** Extract the concatenated text from the first candidate, or "" if none. PURE +
 *  exported so response parsing is unit-testable without a live key. */
export function extractTextFromGeminiResponse(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const candidates = (data as GeminiResponse).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

/** Parse a meal-vision Gemini response into dishes, reusing the Codex path's
 *  robust "last valid JSON block wins" extractor. Throws (never fabricates) when
 *  nothing parses — same contract as the Codex provider. PURE + exported. */
export function parseMealResponse(data: unknown): IdentifiedDish[] {
  const text = extractTextFromGeminiResponse(data);
  if (!text) {
    throw new Error("GeminiProvider: empty response from Gemini");
  }
  return extractDishesFromCodexOutput(text);
}

export interface GeminiProviderConfig {
  /** API key; defaults to GEMINI_API_KEY env. Never hardcoded/logged. */
  apiKey?: string;
  /** Meal-vision model; defaults to MEAL_VISION_MODEL env, else gemini-2.0-flash. */
  model?: string;
  /** Per-call timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Test seam: inject a fetch impl so tests never hit the network. */
  fetchImpl?: typeof fetch;
  /** Override the base URL (tests). Defaults to the Gemini v1beta endpoint. */
  baseUrl?: string;
}

/**
 * POST a generateContent body to Gemini and return the parsed JSON, with a
 * timeout. The key goes in the x-goog-api-key header (never in the URL/logs).
 * Throws on a non-2xx (surfacing only the status — never the key) or timeout.
 */
async function callGemini(
  baseUrl: string,
  model: string,
  apiKey: string,
  body: GeminiGenerateContentBody,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  if (!apiKey) {
    throw new Error("GeminiProvider: GEMINI_API_KEY is required");
  }
  const url = `${baseUrl}/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Surface only the status code — never the key or the (untrusted) body.
      throw new Error(`Gemini API error: ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class GeminiProvider implements MealVisionProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(cfg: GeminiProviderConfig = {}) {
    this.apiKey = cfg.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.model = cfg.model || process.env.MEAL_VISION_MODEL || DEFAULT_MEAL_MODEL;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.baseUrl = cfg.baseUrl ?? GEMINI_BASE_URL;
  }

  async analyzeMeal(input: AnalyzeInput): Promise<AnalyzeResult> {
    const images = collectMealImages(input);
    const text =
      typeof input.text === "string" && input.text.trim().length > 0
        ? input.text.trim()
        : undefined;
    if (images.length === 0 && !text) {
      throw new Error("GeminiProvider: image or text required");
    }

    const body = buildMealRequestBody(images, text);
    const data = await callGemini(
      this.baseUrl,
      this.model,
      this.apiKey,
      body,
      this.timeoutMs,
      this.fetchImpl,
    );
    const dishes = parseMealResponse(data);
    return { dishes, generatedBy: mealGeneratedBy(this.model) };
  }
}

export interface GeminiChatProviderConfig {
  /** API key; defaults to GEMINI_API_KEY env. Never hardcoded/logged. */
  apiKey?: string;
  /** Chat model; defaults to CHAT_MODEL env, else gemini-2.0-flash. */
  model?: string;
  /** Per-call timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Test seam: inject a fetch impl so tests never hit the network. */
  fetchImpl?: typeof fetch;
  /** Override the base URL (tests). */
  baseUrl?: string;
}

export class GeminiChatProvider implements ChatProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(cfg: GeminiChatProviderConfig = {}) {
    this.apiKey = cfg.apiKey ?? process.env.GEMINI_API_KEY ?? "";
    this.model = cfg.model || process.env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.baseUrl = cfg.baseUrl ?? GEMINI_BASE_URL;
  }

  async reply(input: { messages: ChatTurn[]; context?: ChatContext }): Promise<string> {
    if (!input.messages || input.messages.length === 0) {
      throw new Error("GeminiChatProvider: at least one message required");
    }
    const body = buildChatRequestBody(input.messages, input.context);
    const data = await callGemini(
      this.baseUrl,
      this.model,
      this.apiKey,
      body,
      this.timeoutMs,
      this.fetchImpl,
    );
    const reply = extractTextFromGeminiResponse(data);
    if (!reply) {
      throw new Error("GeminiChatProvider: empty reply from Gemini");
    }
    return reply;
  }
}

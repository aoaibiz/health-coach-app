// ============================================================================
// LEGACY / OPTIONAL PROVIDER — NOT the default runtime path.
// ----------------------------------------------------------------------------
// The DEFAULT, active meal-vision path is the subscription Codex CLI provider
// (functions/_llm/codex.ts), which needs NO paid API key. This Anthropic
// provider is kept as an OPTIONAL alternative for self-hosters who would rather
// call the Anthropic Messages API directly; it is inert unless explicitly wired
// up and requires an `ANTHROPIC_API_KEY`. It is intentionally NOT deleted (it
// still compiles and works), but OSS readers should treat the Codex path as the
// one to start from. See the root README "LLM providers" note.
// ============================================================================
//
// AnthropicProvider — the meal-vision adapter for the Anthropic Messages API.
//
// Swappable by env:
//   - model id  ← MEAL_VISION_MODEL  (default "claude-haiku-4-5"; override by env)
//   - api key   ← ANTHROPIC_API_KEY  (server-side runtime env ONLY; never logged,
//                  never hardcoded, never shipped to the client or committed)
//
// We call the Messages API over `fetch` (the Cloudflare Pages Functions runtime
// is fetch-native and has no Node/SDK). The model's ONLY job here is to return
// dish name(s) + estimated grams — it is explicitly instructed NOT to produce
// kcal/PFC, because every nutrition number is computed downstream from the
// grounded MEXT DB (anti-fabrication). We force a single tool call so the output
// is structured JSON we can parse without scraping prose.

import type { AnalyzeInput, AnalyzeResult, MealVisionProvider } from "./provider";
import type { Confidence, IdentifiedDish } from "../_lib/ground";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = [
  "あなたは食事写真・説明文から「料理名」と「推定グラム数」だけを抽出する栄養アシスタントです。",
  "重要: カロリーやPFC（タンパク質・脂質・炭水化物）の数値は絶対に出力しないでください。",
  "それらは別のデータベースで計算します。あなたの仕事は料理の特定と分量(グラム)の推定だけです。",
  "料理名はできるだけ日本語の一般的な食品名（例: ごはん、食パン、卵、鶏むね肉、納豆、うどん、焼き鮭、唐揚げ）で返してください。",
  "確信が持てない場合は confidence を low にしてください。捏造はしないでください。",
].join("");

const DISH_TOOL = {
  name: "report_dishes",
  description:
    "識別した料理ごとに、料理名・推定グラム数・確信度を報告する。カロリー/PFCは含めないこと。",
  input_schema: {
    type: "object",
    properties: {
      dishes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "料理・食品の一般名（日本語）" },
            grams: { type: "number", description: "推定される可食量（グラム）" },
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "識別の確信度",
            },
          },
          required: ["name", "grams"],
        },
      },
    },
    required: ["dishes"],
  },
} as const;

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: { dishes?: Array<{ name?: unknown; grams?: unknown; confidence?: unknown }> };
}

function isConfidence(v: unknown): v is Confidence {
  return v === "low" || v === "medium" || v === "high";
}

/** Coerce one raw tool-reported dish into a clean IdentifiedDish (no numbers). */
function toDish(raw: { name?: unknown; grams?: unknown; confidence?: unknown }): IdentifiedDish | null {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const grams = typeof raw.grams === "number" && Number.isFinite(raw.grams) ? raw.grams : 0;
  return {
    name,
    grams,
    confidence: isConfidence(raw.confidence) ? raw.confidence : "low",
  };
}

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Overrides MEAL_VISION_MODEL / the default. */
  model?: string;
  /** Test seam: inject a fetch impl. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements MealVisionProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: AnthropicProviderConfig) {
    if (!cfg.apiKey) throw new Error("AnthropicProvider: ANTHROPIC_API_KEY is required");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model || DEFAULT_MODEL;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async analyzeMeal(input: AnalyzeInput): Promise<AnalyzeResult> {
    const content: unknown[] = [];
    if (input.imageBase64) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: input.imageBase64 },
      });
    }
    const text = (input.text ?? "").trim();
    content.push({
      type: "text",
      text: text
        ? `この食事を report_dishes ツールで報告してください。説明: ${text}`
        : "この写真の食事を report_dishes ツールで報告してください。",
    });

    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [DISH_TOOL],
      tool_choice: { type: "tool", name: DISH_TOOL.name },
      messages: [{ role: "user", content }],
    };

    const res = await this.fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Surface a non-secret error; the api key is never echoed.
      throw new Error(`Anthropic API error: ${res.status}`);
    }

    const data = (await res.json()) as { content?: unknown[] };
    const blocks = Array.isArray(data.content) ? data.content : [];
    const toolUse = blocks.find(
      (b): b is ToolUseBlock =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "tool_use" &&
        (b as { name?: unknown }).name === DISH_TOOL.name,
    );

    const rawDishes = toolUse?.input?.dishes ?? [];
    const dishes = rawDishes
      .map(toDish)
      .filter((d): d is IdentifiedDish => d !== null);

    return { dishes, generatedBy: this.model };
  }
}

/**
 * Build the configured meal-vision provider from a CF Pages Function env.
 * Reads ANTHROPIC_API_KEY + MEAL_VISION_MODEL from the runtime env ONLY.
 */
export function anthropicProviderFromEnv(env: {
  ANTHROPIC_API_KEY?: string;
  MEAL_VISION_MODEL?: string;
}): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.MEAL_VISION_MODEL,
  });
}

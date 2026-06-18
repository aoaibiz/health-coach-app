// Worker-safe own-key provider selection.
//
// This is the provider selector for the OWN-KEY path that a MEMBER's Cloudflare
// Pages (Workers) deploy runs. A member deploy is ALWAYS own-key (it has no Codex
// CLI subscription) — so this module imports ONLY the fetch-native Gemini
// providers and contains ZERO `node:` imports. The Pages Functions entries
// (functions/api/analyze-meal.ts + chat.ts → onRequestPost) use THESE factories,
// so the worker bundle's static import graph never reaches the Node-only Codex
// providers (functions/_llm/codex.ts / chat.ts → node:child_process / node:fs).
//
// The full env-driven selector that ALSO knows about the local Codex path lives
// in ./select.ts (used by the Node server). That file re-exports ProviderEnv from
// here so there is ONE env-shape definition shared by both runtimes.
//
// SECURITY: no secrets are read except via the passed env object (CF context.env),
// and nothing is logged here.

import type { MealVisionProvider } from "./provider";
import type { ChatProvider } from "./chat";
import { GeminiProvider, GeminiChatProvider } from "./gemini";

/** Env subset the selector reads. Both CF `context.env` and `process.env` fit. */
export interface ProviderEnv {
  /** "own" → use AI_PROVIDER's own-key provider; anything else → local Codex. */
  AI_MODE?: string;
  /** Own-key provider id (only "gemini" is wired now). */
  AI_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  MEAL_VISION_MODEL?: string;
  CHAT_MODEL?: string;
  // Other keys (CODEX_BIN, etc.) are read by the individual providers from
  // process.env in the Node runtime; the selector doesn't need them.
  [key: string]: string | undefined;
}

/** Own-key provider id, normalised (trimmed + lower-cased). */
function ownProvider(env: ProviderEnv): string {
  return (env.AI_PROVIDER ?? "").trim().toLowerCase();
}

/** Whether the deploy is in own-key mode (AI_MODE=own, trim/case-insensitive).
 *  Same resolution as ./select.ts. A member CF deploy MUST be own-key; if it is
 *  not, the caller fails closed (503) rather than trying to run the Node-only
 *  Codex path that the Workers runtime cannot execute. */
function isOwnKeyMode(env: ProviderEnv): boolean {
  return (env.AI_MODE ?? "").trim().toLowerCase() === "own";
}

/**
 * Build the OWN-KEY meal-vision provider for a member CF deploy. The Workers
 * runtime cannot run the Node-only Codex path, so this selector ONLY ever
 * produces an own-key provider:
 *   AI_MODE=own + AI_PROVIDER=gemini → GeminiProvider (member's GEMINI_API_KEY)
 *   anything else                    → throw. The caller maps this to "analysis
 *     unavailable" (503) — never Codex, never a fabricated result.
 */
export function makeOwnKeyMealProvider(env: ProviderEnv = {}): MealVisionProvider {
  if (isOwnKeyMode(env)) {
    switch (ownProvider(env)) {
      case "gemini":
        return new GeminiProvider({
          apiKey: env.GEMINI_API_KEY,
          model: env.MEAL_VISION_MODEL,
        });
    }
  }
  throw new Error(
    `select-own: AI_MODE must be "own" and AI_PROVIDER one of (gemini); got AI_MODE="${env.AI_MODE ?? ""}" AI_PROVIDER="${env.AI_PROVIDER ?? ""}"`,
  );
}

/**
 * Build the OWN-KEY chat provider for a member CF deploy (same resolution as
 * makeOwnKeyMealProvider).
 *   AI_MODE=own + AI_PROVIDER=gemini → GeminiChatProvider (member's GEMINI_API_KEY)
 *   anything else                    → throw (caller maps to "chat unavailable").
 */
export function makeOwnKeyChatProvider(env: ProviderEnv = {}): ChatProvider {
  if (isOwnKeyMode(env)) {
    switch (ownProvider(env)) {
      case "gemini":
        return new GeminiChatProvider({
          apiKey: env.GEMINI_API_KEY,
          model: env.CHAT_MODEL,
        });
    }
  }
  throw new Error(
    `select-own: AI_MODE must be "own" and AI_PROVIDER one of (gemini); got AI_MODE="${env.AI_MODE ?? ""}" AI_PROVIDER="${env.AI_PROVIDER ?? ""}"`,
  );
}

// Provider selection — the ONE place that decides which AI backend powers the
// meal-vision + chat paths, driven by env. This keeps the two runtimes cleanly
// separated:
//
//   AI_MODE=local-codex  (default / unset)  → the subscription Codex CLI
//       providers (CodexProvider / CodexChatProvider). NO API key. This is what
//       OUR / FAMILY instances use; nothing about them changes.
//
//   AI_MODE=own + AI_PROVIDER=gemini         → the member's OWN-key Gemini
//       providers (GeminiProvider / GeminiChatProvider), reading GEMINI_API_KEY
//       from the runtime env. This is what a MEMBER's self-host deploy uses so
//       their meal-photo analysis + coach chat run on their OWN (free Gemini) key.
//
// Structured so additional own-key providers (e.g. AI_PROVIDER=anthropic, which
// already has a reference impl in ./anthropic.ts) can be added later by extending
// the AI_PROVIDER switch — gemini is the only one wired now.
//
// The factories take an env object so they work in BOTH runtimes: the Cloudflare
// Pages Functions runtime passes `context.env`; the Node server passes
// `process.env`. No secrets are read except via this env object, and nothing is
// logged here.

import type { MealVisionProvider } from "./provider";
import type { ChatProvider } from "./chat";
import { CodexProvider } from "./codex";
import { CodexChatProvider } from "./chat";
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

/** Normalise the mode: "own" selects an own-key provider; everything else
 *  (unset, "local-codex", anything unknown) falls back to the Codex path. */
function isOwnKeyMode(env: ProviderEnv): boolean {
  return (env.AI_MODE ?? "").trim().toLowerCase() === "own";
}

function ownProvider(env: ProviderEnv): string {
  return (env.AI_PROVIDER ?? "").trim().toLowerCase();
}

/**
 * Build the meal-vision provider for the current env.
 *   own + gemini → GeminiProvider (member's GEMINI_API_KEY)
 *   else         → CodexProvider (subscription Codex CLI; our/family default)
 */
export function makeMealProvider(env: ProviderEnv = {}): MealVisionProvider {
  if (isOwnKeyMode(env)) {
    switch (ownProvider(env)) {
      case "gemini":
        return new GeminiProvider({
          apiKey: env.GEMINI_API_KEY,
          model: env.MEAL_VISION_MODEL,
        });
      default:
        throw new Error(
          `select: AI_MODE=own but unsupported AI_PROVIDER "${env.AI_PROVIDER ?? ""}" (supported: gemini)`,
        );
    }
  }
  return new CodexProvider();
}

/**
 * Build the chat provider for the current env (same mode resolution as
 * makeMealProvider).
 *   own + gemini → GeminiChatProvider (member's GEMINI_API_KEY)
 *   else         → CodexChatProvider (subscription Codex CLI; our/family default)
 */
export function makeChatProvider(env: ProviderEnv = {}): ChatProvider {
  if (isOwnKeyMode(env)) {
    switch (ownProvider(env)) {
      case "gemini":
        return new GeminiChatProvider({
          apiKey: env.GEMINI_API_KEY,
          model: env.CHAT_MODEL,
        });
      default:
        throw new Error(
          `select: AI_MODE=own but unsupported AI_PROVIDER "${env.AI_PROVIDER ?? ""}" (supported: gemini)`,
        );
    }
  }
  return new CodexChatProvider();
}

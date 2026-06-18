import { describe, it, expect } from "vitest";
import { makeMealProvider, makeChatProvider } from "../_llm/select";
import { CodexProvider } from "../_llm/codex";
import { CodexChatProvider } from "../_llm/chat";
import { GeminiProvider, GeminiChatProvider } from "../_llm/gemini";

// select.ts is the ONE place that decides the AI backend from env. These tests
// assert the mode resolution only — no provider is invoked, so no network/CLI.

describe("makeMealProvider — mode selection", () => {
  it("defaults to the Codex provider when AI_MODE is unset (our/family instance)", () => {
    expect(makeMealProvider({})).toBeInstanceOf(CodexProvider);
  });

  it("uses Codex for AI_MODE=local-codex explicitly", () => {
    expect(makeMealProvider({ AI_MODE: "local-codex" })).toBeInstanceOf(CodexProvider);
  });

  it("uses Gemini for AI_MODE=own + AI_PROVIDER=gemini (member own-key)", () => {
    const p = makeMealProvider({ AI_MODE: "own", AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    expect(p).toBeInstanceOf(GeminiProvider);
  });

  it("is case-insensitive / trims AI_MODE + AI_PROVIDER", () => {
    const p = makeMealProvider({ AI_MODE: " OWN ", AI_PROVIDER: " Gemini ", GEMINI_API_KEY: "k" });
    expect(p).toBeInstanceOf(GeminiProvider);
  });

  it("throws for AI_MODE=own with an unsupported provider (never silently falls back)", () => {
    expect(() => makeMealProvider({ AI_MODE: "own", AI_PROVIDER: "anthropic" })).toThrow(
      /unsupported AI_PROVIDER/,
    );
  });
});

describe("makeChatProvider — mode selection", () => {
  it("defaults to the Codex chat provider when AI_MODE is unset", () => {
    expect(makeChatProvider({})).toBeInstanceOf(CodexChatProvider);
  });

  it("uses Gemini chat for AI_MODE=own + AI_PROVIDER=gemini", () => {
    const p = makeChatProvider({ AI_MODE: "own", AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    expect(p).toBeInstanceOf(GeminiChatProvider);
  });

  it("throws for AI_MODE=own with an unsupported provider", () => {
    expect(() => makeChatProvider({ AI_MODE: "own", AI_PROVIDER: "openai" })).toThrow(
      /unsupported AI_PROVIDER/,
    );
  });
});

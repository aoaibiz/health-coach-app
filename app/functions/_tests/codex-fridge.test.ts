import { describe, it, expect } from "vitest";
import {
  CodexProvider,
  extractFridgeItemsFromCodexOutput,
  type CodexRunner,
} from "../_llm/codex";

// Phase2 (冷蔵庫の写真→献立提案). These NEVER spawn the real CLI — they call the
// pure fridge extractor or inject a fake CodexRunner. We assert: (1) mode:"fridge"
// switches the prompt to ingredient identification, (2) an EMPTY fridge is a valid
// answer (not a thrown error, unlike a meal), (3) anti-fabrication framing is set.

describe("extractFridgeItemsFromCodexOutput — empty is a valid answer", () => {
  it("parses an ingredient list from a fenced json block", () => {
    const text = [
      "banner noise",
      "```json",
      '{"dishes":[{"name":"卵","grams":300,"source":"db","confidence":"high"},{"name":"玉ねぎ","grams":0,"source":"db","confidence":"medium"}]}',
      "```",
    ].join("\n");
    const items = extractFridgeItemsFromCodexOutput(text);
    expect(items).toEqual([
      { name: "卵", grams: 300, source: "db", confidence: "high" },
      { name: "玉ねぎ", grams: 0, source: "db", confidence: "medium" },
    ]);
  });

  it("returns [] (NOT a throw) for an honest empty fridge {dishes:[]}", () => {
    const text = '```json\n{"dishes":[]}\n```';
    expect(extractFridgeItemsFromCodexOutput(text)).toEqual([]);
  });

  it("throws only when there is no {dishes:[...]} object at all", () => {
    expect(() => extractFridgeItemsFromCodexOutput("model refused, no json here")).toThrow();
  });

  it("prefers the LAST valid block (the answer comes after the banner/preamble)", () => {
    const text = [
      '```json\n{"dishes":[{"name":"古い","grams":1,"source":"db","confidence":"low"}]}\n```',
      "...chatter...",
      '```json\n{"dishes":[{"name":"豆腐","grams":150,"source":"db","confidence":"high"}]}\n```',
    ].join("\n");
    expect(extractFridgeItemsFromCodexOutput(text)).toEqual([
      { name: "豆腐", grams: 150, source: "db", confidence: "high" },
    ]);
  });
});

describe("CodexProvider.analyzeMeal — mode:'fridge' uses the fridge prompt", () => {
  it("sends the FRIDGE prompt (visible ingredients, anti-fabrication) when mode='fridge'", async () => {
    let seenPrompt = "";
    const runner: CodexRunner = async ({ prompt }) => {
      seenPrompt = prompt;
      return {
        stdout: '```json\n{"dishes":[{"name":"鶏むね肉","grams":200,"source":"db","confidence":"high"}]}\n```',
      };
    };
    const provider = new CodexProvider({ runner });
    const result = await provider.analyzeMeal({ text: "これで何作れる？", mode: "fridge" });

    // Fridge framing: identify visible ingredients, no fabrication of unseen foods.
    expect(seenPrompt).toContain("冷蔵庫");
    expect(seenPrompt).toContain("見えている食材だけ");
    // The user's hint text is appended (but only as a hint).
    expect(seenPrompt).toContain("これで何作れる？");
    expect(result.dishes).toEqual([
      { name: "鶏むね肉", grams: 200, source: "db", confidence: "high" },
    ]);
  });

  it("mode='fridge' tolerates an empty fridge (returns dishes:[] instead of throwing)", async () => {
    const runner: CodexRunner = async () => ({ stdout: '```json\n{"dishes":[]}\n```' });
    const provider = new CodexProvider({ runner });
    const result = await provider.analyzeMeal({ imageBase64: "ZmFrZQ==", mode: "fridge" });
    expect(result.dishes).toEqual([]);
  });

  it("default mode (no mode) still uses the MEAL prompt + requires ≥1 dish", async () => {
    let seenPrompt = "";
    const runner: CodexRunner = async ({ prompt }) => {
      seenPrompt = prompt;
      return { stdout: '```json\n{"dishes":[{"name":"ごはん","grams":150,"confidence":"high"}]}\n```' };
    };
    const provider = new CodexProvider({ runner });
    const result = await provider.analyzeMeal({ text: "ごはん" });
    // The meal prompt frames it as a 食事写真, NOT a fridge.
    expect(seenPrompt).toContain("食事写真の解析アシスタント");
    expect(seenPrompt).not.toContain("冷蔵庫");
    expect(result.dishes[0].name).toBe("ごはん");
  });

  it("meal mode still THROWS on an empty dishes array (a meal must have a dish)", async () => {
    const runner: CodexRunner = async () => ({ stdout: '```json\n{"dishes":[]}\n```' });
    const provider = new CodexProvider({ runner });
    await expect(provider.analyzeMeal({ text: "なにか" })).rejects.toThrow();
  });
});

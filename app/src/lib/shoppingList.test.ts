import { describe, it, expect } from "vitest";
import { computeShoppingList, normalizeIngredient } from "./shoppingList";

describe("normalizeIngredient", () => {
  it("strips quantity + units + symbols so the food name remains", () => {
    expect(normalizeIngredient("鶏むね肉 100g")).toBe("鶏むね肉");
    expect(normalizeIngredient("卵 2個")).toBe("卵");
    expect(normalizeIngredient("醤油 大さじ1")).toBe("醤油");
    expect(normalizeIngredient("  ごはん（150g）  ")).toBe("ごはん");
  });
  it("returns empty for non-strings / blanks", () => {
    expect(normalizeIngredient("")).toBe("");
    // @ts-expect-error intentional bad input
    expect(normalizeIngredient(null)).toBe("");
  });
});

describe("computeShoppingList — 材料 − 手元の食材 (買い物リスト⑤, deterministic)", () => {
  it("returns only ingredients NOT on hand (あるものは入れない)", () => {
    const list = computeShoppingList(
      ["鶏むね肉 120g", "卵 2個", "醤油"],
      ["卵", "醤油"],
    );
    expect(list).toEqual(["鶏むね肉 120g"]);
  });

  it("matches loosely either-direction (on-hand '卵' covers '卵 2個')", () => {
    expect(computeShoppingList(["卵 2個"], ["卵"])).toEqual([]);
    expect(computeShoppingList(["鶏むね肉"], ["鶏むね肉 200g"])).toEqual([]);
  });

  it("with NO fridge context returns the WHOLE list (never guesses on-hand)", () => {
    expect(computeShoppingList(["ごはん 150g", "鮭 80g"], undefined)).toEqual([
      "ごはん 150g",
      "鮭 80g",
    ]);
    expect(computeShoppingList(["ごはん"], [])).toEqual(["ごはん"]);
  });

  it("de-duplicates by normalised name + drops blanks; preserves original strings", () => {
    expect(computeShoppingList(["ごはん 150g", "ごはん", "  ", "鮭 80g"], [])).toEqual([
      "ごはん 150g",
      "鮭 80g",
    ]);
  });

  it("never ADDS an ingredient the recipe didn't list (only removes on-hand)", () => {
    // On-hand items not in the recipe don't appear in the output.
    const list = computeShoppingList(["鶏むね肉"], ["卵", "牛乳", "鶏むね肉"]);
    expect(list).toEqual([]); // 鶏むね肉 is on hand → empty; 卵/牛乳 never appear
  });

  it("empty/absent ingredients → empty list", () => {
    expect(computeShoppingList(undefined, ["卵"])).toEqual([]);
    expect(computeShoppingList([], ["卵"])).toEqual([]);
  });
});

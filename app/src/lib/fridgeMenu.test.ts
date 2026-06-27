import { describe, it, expect } from "vitest";
import {
  analyzeFridge,
  fridgeResponseToAnalysis,
  isFridgeMenuIntent,
  NON_FRIDGE_ANALYSIS,
} from "./fridgeMenu";
import type { AnalyzeMealApiResponse } from "./analyzeMeal";

// Pure tests — no DOM, no real network (analyzeFridge takes an injected fetch).
// Phase2 (冷蔵庫の写真→献立提案): the intent gate must fire on a genuine menu ask and
// stay quiet on a normal "log this meal" photo turn, and the response mapper must
// forward ONLY identified ingredients (never invent one) with an empty result honest.

describe("isFridgeMenuIntent — routes a photo turn to fridge analysis ONLY on a menu ask", () => {
  it("fires on explicit menu-request phrases", () => {
    for (const t of [
      "この冷蔵庫で献立考えて",
      "これで何作れる？",
      "何が作れるかな",
      "冷蔵庫の中身でメニュー提案して",
      "夕飯どうしよう",
      "この食材でレシピ教えて",
      "材料これだけだけど何作ろう",
      "晩ご飯どうしよう、写真送るね",
    ]) {
      expect(isFridgeMenuIntent(t)).toBe(true);
    }
  });

  it("fires on a fridge/ingredient word + a make/propose verb", () => {
    expect(isFridgeMenuIntent("冷蔵庫の中で作れるもの教えて")).toBe(true);
    expect(isFridgeMenuIntent("食材から提案して")).toBe(true);
    expect(isFridgeMenuIntent("この材料で考えてほしい")).toBe(true);
  });

  it("does NOT fire on a normal meal-log photo turn (so it isn't mis-routed)", () => {
    for (const t of [
      "これ食べた",
      "今日の昼ごはん記録して",
      "親子丼を食べました",
      "この食事登録して",
      "朝食です",
      "",
      "ありがとう",
    ]) {
      expect(isFridgeMenuIntent(t)).toBe(false);
    }
  });

  it("a bare fridge/ingredient word WITHOUT a make-verb does not fire (avoid false positives)", () => {
    // "冷蔵庫を掃除した" mentions the fridge but isn't a menu ask.
    expect(isFridgeMenuIntent("冷蔵庫を掃除した")).toBe(false);
    expect(isFridgeMenuIntent("食材を買ってきた")).toBe(false);
  });
});

/** Build a minimal fridge-mode API response (only the fields the mapper reads). */
function fridgeResponse(
  items: Array<{ name: string; grams: number }>,
): AnalyzeMealApiResponse {
  return {
    items: items.map((it) => ({
      name: it.name,
      grams: it.grams,
      kcal: null,
      protein_g: null,
      fat_g: null,
      carb_g: null,
      source: null,
      sourceKind: null,
      sourceLabel: null,
      estimated: false,
      confidence: "low",
      matched: false,
    })),
    totals: {
      kcal: 0,
      protein_g: null,
      fat_g: null,
      carb_g: null,
      fiber_g: null,
      sugar_g: null,
      sodium_mg: null,
      saturated_fat_g: null,
    },
    generatedBy: "test",
    matchedCount: 0,
    numberedCount: 0,
    totalsIncludeEstimate: false,
  };
}

describe("fridgeResponseToAnalysis — forwards only identified ingredients", () => {
  it("maps item names + positive grams to ingredients (ok:true)", () => {
    const out = fridgeResponseToAnalysis(
      fridgeResponse([
        { name: "卵", grams: 300 },
        { name: "鶏むね肉", grams: 200 },
        { name: "玉ねぎ", grams: 0 },
      ]),
    );
    expect(out.ok).toBe(true);
    expect(out.ingredients).toEqual([
      { name: "卵", grams: 300 },
      { name: "鶏むね肉", grams: 200 },
      { name: "玉ねぎ" }, // grams:0 → omitted (unknown on-hand amount)
    ]);
  });

  it("drops items with no usable name (never invents one)", () => {
    const out = fridgeResponseToAnalysis(fridgeResponse([{ name: "  ", grams: 100 }]));
    expect(out.ingredients).toEqual([]);
  });

  it("an empty fridge response is a valid 'nothing identified' answer (ok:true, [])", () => {
    const out = fridgeResponseToAnalysis(fridgeResponse([]));
    expect(out).toEqual({ ok: true, ingredients: [] });
  });
});

describe("analyzeFridge — sends mode:fridge + maps the response", () => {
  it("posts mode:'fridge' and returns the mapped ingredients", async () => {
    let sentBody: unknown;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(fridgeResponse([{ name: "豆腐", grams: 150 }])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await analyzeFridge(
      { imageBase64List: ["ZmFrZQ=="], text: "これで何作れる？" },
      { fetchImpl: fakeFetch },
    );
    expect((sentBody as { mode?: string }).mode).toBe("fridge");
    expect((sentBody as { text?: string }).text).toBe("これで何作れる？");
    expect(out).toEqual({ ok: true, ingredients: [{ name: "豆腐", grams: 150 }] });
  });

  it("throws on a non-OK response (caller then uses NON_FRIDGE_ANALYSIS)", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      analyzeFridge({ imageBase64List: ["x"] }, { fetchImpl: fakeFetch }),
    ).rejects.toThrow();
  });

  it("throws when no image is supplied", async () => {
    await expect(analyzeFridge({ imageBase64List: [] })).rejects.toThrow();
  });

  it("NON_FRIDGE_ANALYSIS signals an unreadable fridge photo", () => {
    expect(NON_FRIDGE_ANALYSIS).toEqual({ ok: false });
  });
});

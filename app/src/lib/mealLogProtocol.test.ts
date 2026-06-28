import { describe, it, expect } from "vitest";
import {
  MEAL_LOG_OPEN,
  MEAL_LOG_CLOSE,
  hasMealLogBlock,
  parseCoachReply,
} from "./mealLogProtocol";

/** Wrap a JSON object in the sentinel block, optionally with surrounding prose. */
function withBlock(json: unknown, prose = "OK、食事に登録しておきました。"): string {
  return `${prose}\n${MEAL_LOG_OPEN}${JSON.stringify(json)}${MEAL_LOG_CLOSE}`;
}

describe("parseCoachReply — strips the auto-log block, keeps natural prose", () => {
  it("parses a valid block and removes it from the displayed text", () => {
    const raw = withBlock({
      items: [
        { name: "ごはん", grams: 150, qty: 1, source: "db" },
        { name: "焼き鮭", grams: 80, source: "db" },
      ],
      type: "昼",
    });
    const { display, payload } = parseCoachReply(raw);

    // The user sees ONLY natural prose — never the JSON or the sentinels.
    expect(display).toBe("OK、食事に登録しておきました。");
    expect(display).not.toContain(MEAL_LOG_OPEN);
    expect(display).not.toContain(MEAL_LOG_CLOSE);
    expect(display).not.toContain("items");
    expect(display).not.toContain("grams");

    expect(payload).not.toBeNull();
    expect(payload?.items).toHaveLength(2);
    expect(payload?.items[0]).toEqual({ name: "ごはん", grams: 150, qty: 1, source: "db" });
    expect(payload?.type).toBe("昼");
  });

  it("returns the trimmed text + null payload when there is no block", () => {
    const { display, payload } = parseCoachReply("  今日のメニューはこれとこれですか？  ");
    expect(display).toBe("今日のメニューはこれとこれですか？");
    expect(payload).toBeNull();
  });

  it("never shows raw JSON even when the block JSON is MALFORMED (strips, no log)", () => {
    const raw = `登録しました。\n${MEAL_LOG_OPEN}{"items": [oops not json${MEAL_LOG_CLOSE}`;
    const { display, payload } = parseCoachReply(raw);
    // Block stripped from display; payload null so nothing gets logged.
    expect(display).toBe("登録しました。");
    expect(display).not.toContain(MEAL_LOG_OPEN);
    expect(display).not.toContain("items");
    expect(payload).toBeNull();
  });

  it("tolerates an inner ```json fence the model may add", () => {
    const inner = "```json\n" + JSON.stringify({ items: [{ name: "卵", grams: 50 }] }) + "\n```";
    const raw = `${MEAL_LOG_OPEN}${inner}${MEAL_LOG_CLOSE}`;
    const { payload } = parseCoachReply(raw);
    expect(payload?.items).toEqual([{ name: "卵", grams: 50 }]);
  });

  it("KEEPS a named item with missing/≤0 grams (grams→0, grounding defaults the portion); drops only nameless garbage", () => {
    // The invariant: a NAMED food the user mentioned is never dropped — it logs
    // with a real calorie once grounding defaults the portion. A grams 0 / missing
    // named item is KEPT here with grams 0 (a number); only items with NO usable
    // name are discarded (nothing to ground).
    const raw = withBlock({
      items: [
        { name: "ごはん", grams: 150 },
        { name: "", grams: 100 }, // no name → dropped
        { name: "焼きさつまいも", grams: 0 }, // named, grams 0 → KEPT (grams 0)
        { name: "麦茶" }, // named, no grams → KEPT (grams 0)
        { name: "  ", grams: 50 }, // whitespace-only name → dropped
        { grams: 50 }, // no name → dropped
      ],
    });
    const { payload } = parseCoachReply(raw);
    expect(payload?.items).toEqual([
      { name: "ごはん", grams: 150 },
      { name: "焼きさつまいも", grams: 0 }, // KEPT — grounding will default to 100g
      { name: "麦茶", grams: 0 }, // KEPT — grounding will default to 100g
    ]);
  });

  it("normalises NEGATIVE / NaN grams on a NAMED item to 0 (kept; grounding defaults)", () => {
    const raw = withBlock({
      items: [
        { name: "焼き芋", grams: -50 }, // negative → 0, kept
        { name: "卵", grams: "ごろっと" }, // non-number → 0, kept
      ],
    });
    const { payload } = parseCoachReply(raw);
    expect(payload?.items).toEqual([
      { name: "焼き芋", grams: 0 },
      { name: "卵", grams: 0 },
    ]);
  });

  it("returns null payload when the block has zero usable (named) items", () => {
    // Only nameless garbage → nothing to ground → null payload.
    const raw = withBlock({ items: [{ name: "", grams: 0 }, { grams: 50 }] });
    const { payload, display } = parseCoachReply(raw);
    expect(payload).toBeNull();
    // Still stripped — no raw JSON leaks.
    expect(display).not.toContain("items");
  });

  it("carries label/estimate anchor numbers through (for the grounding layer)", () => {
    const raw = withBlock({
      items: [
        { name: "プロテインバー", grams: 45, source: "label", kcal: 190, protein_g: 15, fat_g: 7, carb_g: 18 },
      ],
    });
    const { payload } = parseCoachReply(raw);
    expect(payload?.items[0]).toEqual({
      name: "プロテインバー",
      grams: 45,
      source: "label",
      kcal: 190,
      protein_g: 15,
      fat_g: 7,
      carb_g: 18,
    });
  });

  it("carries portion_basis through so grounding can distinguish stated vs standard portions", () => {
    const raw = withBlock({
      items: [{ name: "鶏むね肉 皮なし", grams: 20, source: "db", portion_basis: "standard" }],
    });
    const { payload } = parseCoachReply(raw);
    expect(payload?.items[0]).toEqual({
      name: "鶏むね肉 皮なし",
      grams: 20,
      source: "db",
      portion_basis: "standard",
    });
  });

  it("ignores an invalid meal type", () => {
    const raw = withBlock({ items: [{ name: "卵", grams: 50 }], type: "ブランチ" });
    const { payload } = parseCoachReply(raw);
    expect(payload?.type).toBeUndefined();
  });
});

describe("hasMealLogBlock", () => {
  it("detects a present block (even malformed) and reports absence", () => {
    expect(hasMealLogBlock(withBlock({ items: [{ name: "卵", grams: 50 }] }))).toBe(true);
    expect(hasMealLogBlock(`${MEAL_LOG_OPEN}garbage${MEAL_LOG_CLOSE}`)).toBe(true);
    expect(hasMealLogBlock("ふつうの返信です")).toBe(false);
  });
});

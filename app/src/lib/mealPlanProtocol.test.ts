import { describe, it, expect } from "vitest";
import {
  MEAL_PLAN_OPEN,
  MEAL_PLAN_CLOSE,
  hasMealPlanBlock,
  parseMealPlanReply,
} from "./mealPlanProtocol";

/** Wrap a JSON object in the meal-PLAN sentinel block, with optional prose. */
function withBlock(json: unknown, prose = "今日の献立を食事に入れておきました。"): string {
  return `${prose}\n${MEAL_PLAN_OPEN}${JSON.stringify(json)}${MEAL_PLAN_CLOSE}`;
}

describe("parseMealPlanReply — strips the plan block, keeps natural prose", () => {
  it("parses a valid 献立 (meals + items + recipe + time) and removes it from the text", () => {
    const raw = withBlock({
      meals: [
        {
          type: "朝",
          items: [
            { name: "ごはん", grams: 150, source: "db" },
            { name: "卵", grams: 50, qty: 2, source: "db" },
          ],
          recipe: {
            ingredients: ["ごはん 150g", "卵 2個"],
            steps: ["卵を焼く", "ごはんに乗せる"],
          },
          start: "2026-06-26T08:00:00+09:00",
          end: "2026-06-26T08:30:00+09:00",
        },
        {
          type: "昼",
          items: [{ name: "鶏むね肉", grams: 120, source: "db" }],
        },
      ],
      mode: "new",
    });
    const { display, payload } = parseMealPlanReply(raw);

    // The user sees ONLY natural prose — never the JSON or the sentinels.
    expect(display).toBe("今日の献立を食事に入れておきました。");
    expect(display).not.toContain(MEAL_PLAN_OPEN);
    expect(display).not.toContain("meals");
    expect(display).not.toContain("ごはん");

    expect(payload).not.toBeNull();
    expect(payload?.meals).toHaveLength(2);
    expect(payload?.meals[0].type).toBe("朝");
    expect(payload?.meals[0].items).toEqual([
      { name: "ごはん", grams: 150, source: "db" },
      { name: "卵", grams: 50, qty: 2, source: "db" },
    ]);
    expect(payload?.meals[0].recipe).toEqual({
      ingredients: ["ごはん 150g", "卵 2個"],
      steps: ["卵を焼く", "ごはんに乗せる"],
    });
    expect(payload?.meals[0].start).toBe("2026-06-26T08:00:00+09:00");
    expect(payload?.meals[0].end).toBe("2026-06-26T08:30:00+09:00");
    expect(payload?.meals[1].type).toBe("昼");
    expect(payload?.mode).toBe("new");
  });

  it("defaults mode to 'new' when omitted (never silently overwrites)", () => {
    const { payload } = parseMealPlanReply(
      withBlock({ meals: [{ type: "夕", items: [{ name: "鮭", grams: 80 }] }] }),
    );
    expect(payload?.mode).toBe("new");
  });

  it("parses 'correct' mode (an explicit plan correction)", () => {
    const { payload } = parseMealPlanReply(
      withBlock({ meals: [{ items: [{ name: "豆腐", grams: 150 }] }], mode: "correct" }),
    );
    expect(payload?.mode).toBe("correct");
  });

  it("tolerates a ```json fence inside the block", () => {
    const raw = `はい。\n${MEAL_PLAN_OPEN}\n\`\`\`json\n${JSON.stringify({
      meals: [{ type: "昼", items: [{ name: "ごはん", grams: 150 }] }],
    })}\n\`\`\`\n${MEAL_PLAN_CLOSE}`;
    const { display, payload } = parseMealPlanReply(raw);
    expect(display).toBe("はい。");
    expect(payload?.meals).toHaveLength(1);
  });

  it("captures recipe.onHand for the shopping-list diff (買い物リスト⑤)", () => {
    const { payload } = parseMealPlanReply(
      withBlock({
        meals: [
          {
            type: "夕",
            items: [{ name: "鶏むね肉", grams: 120 }],
            recipe: { ingredients: ["鶏むね肉 120g", "醤油"], onHand: ["醤油"] },
          },
        ],
      }),
    );
    expect(payload?.meals[0].recipe?.onHand).toEqual(["醤油"]);
  });
});

describe("parseMealPlanReply — anti-garbage / fabrication safety", () => {
  it("drops a meal with no usable item, and nulls a payload with zero meals", () => {
    // A meal whose only item has no name is dropped → no usable meals → null payload.
    const { display, payload } = parseMealPlanReply(
      withBlock({ meals: [{ type: "朝", items: [{ grams: 100 }] }] }),
    );
    // Block is ALWAYS stripped even when it parses to nothing (no raw JSON leaks).
    expect(display).toBe("今日の献立を食事に入れておきました。");
    expect(display).not.toContain(MEAL_PLAN_OPEN);
    expect(payload).toBeNull();
  });

  it("keeps a meal but DROPS a partial/zoneless time (calendar reflection skipped)", () => {
    const { payload } = parseMealPlanReply(
      withBlock({
        meals: [
          {
            type: "昼",
            items: [{ name: "ごはん", grams: 150 }],
            start: "2026-06-26T12:00:00", // no zone → invalid
            end: "2026-06-26T12:30:00+09:00",
          },
        ],
      }),
    );
    expect(payload?.meals).toHaveLength(1); // the plan still inserts
    expect(payload?.meals[0].start).toBeUndefined(); // but no calendar time
    expect(payload?.meals[0].end).toBeUndefined();
  });

  it("drops an inverted time window (end ≤ start)", () => {
    const { payload } = parseMealPlanReply(
      withBlock({
        meals: [
          {
            type: "夕",
            items: [{ name: "鮭", grams: 80 }],
            start: "2026-06-26T19:00:00+09:00",
            end: "2026-06-26T18:00:00+09:00",
          },
        ],
      }),
    );
    expect(payload?.meals[0].start).toBeUndefined();
    expect(payload?.meals[0].end).toBeUndefined();
  });

  it("returns null payload + strips the block on malformed JSON (no leak)", () => {
    const raw = `これでいきましょう。\n${MEAL_PLAN_OPEN}{not json${MEAL_PLAN_CLOSE}`;
    const { display, payload } = parseMealPlanReply(raw);
    expect(payload).toBeNull();
    expect(display).toBe("これでいきましょう。");
    expect(display).not.toContain(MEAL_PLAN_OPEN);
  });

  it("returns the trimmed input + null when there is no block", () => {
    const { display, payload } = parseMealPlanReply("  ただの雑談です。  ");
    expect(display).toBe("ただの雑談です。");
    expect(payload).toBeNull();
  });

  it("drops an unknown meal type (defaulted later by the applier)", () => {
    const { payload } = parseMealPlanReply(
      withBlock({ meals: [{ type: "ブランチ", items: [{ name: "ごはん", grams: 150 }] }] }),
    );
    expect(payload?.meals[0].type).toBeUndefined();
  });

  it("drops an empty recipe (no ingredients AND no steps)", () => {
    const { payload } = parseMealPlanReply(
      withBlock({
        meals: [{ type: "昼", items: [{ name: "ごはん", grams: 150 }], recipe: { ingredients: [], steps: [] } }],
      }),
    );
    expect(payload?.meals[0].recipe).toBeUndefined();
  });
});

describe("hasMealPlanBlock", () => {
  it("detects a (possibly malformed) block", () => {
    expect(hasMealPlanBlock(`x${MEAL_PLAN_OPEN}garbage${MEAL_PLAN_CLOSE}`)).toBe(true);
    expect(hasMealPlanBlock("no block here")).toBe(false);
  });
});

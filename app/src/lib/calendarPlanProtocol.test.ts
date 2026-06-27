import { describe, it, expect } from "vitest";
import {
  parseCalendarReply,
  hasCalendarPlanBlock,
  CALENDAR_PLAN_OPEN,
  CALENDAR_PLAN_CLOSE,
} from "./calendarPlanProtocol";

/** Build a reply that wraps `inner` JSON in the sentinel block, with prose. */
function withBlock(prose: string, inner: string): string {
  return `${prose}\n${CALENDAR_PLAN_OPEN}${inner}${CALENDAR_PLAN_CLOSE}`;
}

const ITEM = {
  type: "食事",
  title: "昼食（高たんぱく）",
  start: "2026-06-25T12:00:00+09:00",
  end: "2026-06-25T12:30:00+09:00",
};

describe("parseCalendarReply — happy path", () => {
  it("parses a valid plan and strips the block from the display", () => {
    const raw = withBlock("お昼の予定を入れますね。", JSON.stringify({ items: [ITEM], timeZone: "Asia/Tokyo" }));
    const { display, payload } = parseCalendarReply(raw);
    expect(display).toBe("お昼の予定を入れますね。");
    expect(display).not.toContain(CALENDAR_PLAN_OPEN);
    expect(payload).not.toBeNull();
    expect(payload!.items).toHaveLength(1);
    expect(payload!.items[0].title).toBe("昼食（高たんぱく）");
    expect(payload!.items[0].type).toBe("食事");
    expect(payload!.timeZone).toBe("Asia/Tokyo");
  });

  it("carries optional notes through", () => {
    const raw = withBlock("ok", JSON.stringify({ items: [{ ...ITEM, notes: "鶏むね肉中心" }] }));
    const { payload } = parseCalendarReply(raw);
    expect(payload!.items[0].notes).toBe("鶏むね肉中心");
  });

  it("tolerates a ```json fence inside the block", () => {
    const inner = "```json\n" + JSON.stringify({ items: [ITEM] }) + "\n```";
    const { payload } = parseCalendarReply(withBlock("ok", inner));
    expect(payload).not.toBeNull();
    expect(payload!.items).toHaveLength(1);
  });
});

describe("parseCalendarReply — anti-fabrication / strictness", () => {
  it("no block → payload null, display is the trimmed prose", () => {
    const { display, payload } = parseCalendarReply("  ただの返信です  ");
    expect(payload).toBeNull();
    expect(display).toBe("ただの返信です");
  });

  it("ALWAYS strips a malformed block (raw JSON never reaches the user)", () => {
    const raw = withBlock("ok", "{ not valid json");
    const { display, payload } = parseCalendarReply(raw);
    expect(payload).toBeNull();
    expect(display).toBe("ok");
    expect(display).not.toContain(CALENDAR_PLAN_OPEN);
  });

  it("DROPS an item with a zoneless start (never invents a zone)", () => {
    const bad = { ...ITEM, start: "2026-06-25T12:00:00" }; // no offset
    const { payload } = parseCalendarReply(withBlock("ok", JSON.stringify({ items: [bad] })));
    expect(payload).toBeNull(); // the only item dropped → no usable plan
  });

  it("DROPS an item where end <= start", () => {
    const bad = { ...ITEM, end: "2026-06-25T11:00:00+09:00" };
    const { payload } = parseCalendarReply(withBlock("ok", JSON.stringify({ items: [bad] })));
    expect(payload).toBeNull();
  });

  it("DROPS an unknown type and an empty title", () => {
    const badType = { ...ITEM, type: "睡眠" };
    const badTitle = { ...ITEM, title: "   " };
    expect(parseCalendarReply(withBlock("ok", JSON.stringify({ items: [badType] }))).payload).toBeNull();
    expect(parseCalendarReply(withBlock("ok", JSON.stringify({ items: [badTitle] }))).payload).toBeNull();
  });

  it("keeps the valid items and drops only the invalid ones in a mixed plan", () => {
    const bad = { ...ITEM, start: "nope" };
    const { payload } = parseCalendarReply(withBlock("ok", JSON.stringify({ items: [ITEM, bad] })));
    expect(payload!.items).toHaveLength(1);
    expect(payload!.items[0].title).toBe(ITEM.title);
  });

  it("caps the number of items at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...ITEM, title: `予定${i}` }));
    const { payload } = parseCalendarReply(withBlock("ok", JSON.stringify({ items: many })));
    expect(payload!.items.length).toBeLessThanOrEqual(20);
  });

  it("empty items array → null payload", () => {
    expect(parseCalendarReply(withBlock("ok", JSON.stringify({ items: [] }))).payload).toBeNull();
  });
});

describe("hasCalendarPlanBlock", () => {
  it("detects a present block (even malformed) and ignores plain prose", () => {
    expect(hasCalendarPlanBlock(withBlock("x", "{}"))).toBe(true);
    expect(hasCalendarPlanBlock("ただの会話")).toBe(false);
  });
});

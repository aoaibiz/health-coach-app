import { describe, it, expect } from "vitest";
import {
  ambiguousDateNote,
  backdatedNote,
  resolveRelativeDateKey,
  resolveRelativeDateKeyForKind,
} from "./relativeDate";

// A fixed "now" so the date math is deterministic. 2026-06-21 is a Sunday.
const NOW = new Date(2026, 5, 21, 23, 30); // local time (month is 0-based)

describe("resolveRelativeDateKey — explicit relative day + logging intent", () => {
  it("'これ昨日の分で記入して' → yesterday's key", () => {
    expect(resolveRelativeDateKey("これ昨日の分で記入して", NOW)).toBe("2026-06-20");
  });

  it("'一昨日の分として登録して' → two days ago", () => {
    expect(resolveRelativeDateKey("一昨日の分として登録して", NOW)).toBe("2026-06-19");
  });

  it("'おとといの記録つけといて' → two days ago (kana)", () => {
    expect(resolveRelativeDateKey("おとといの記録つけといて", NOW)).toBe("2026-06-19");
  });

  it("'今日の分で記録して' → today's key (explicit today)", () => {
    expect(resolveRelativeDateKey("今日の分で記録して", NOW)).toBe("2026-06-21");
  });

  it("a casual mention WITHOUT logging intent → null (no surprise back-date)", () => {
    expect(resolveRelativeDateKey("昨日は食べすぎたなあ", NOW)).toBeNull();
    expect(resolveRelativeDateKey("きのうは疲れた", NOW)).toBeNull();
  });

  it("no relative day word → null (caller uses today)", () => {
    expect(resolveRelativeDateKey("唐揚げ食べた、記録して", NOW)).toBeNull();
    expect(resolveRelativeDateKey("", NOW)).toBeNull();
  });

  it("most-specific day word wins (一昨日 over 昨日 in the same phrase)", () => {
    expect(resolveRelativeDateKey("一昨日の分で記入", NOW)).toBe("2026-06-19");
  });
});

describe("resolveRelativeDateKeyForKind — per-block relative date (Major-2 fix)", () => {
  it("attributes each kind to its OWN day word in a mixed message (no take-over)", () => {
    // The marquee case: "昨日の夕食と今日の筋トレを記録して" must backdate the MEAL
    // to yesterday WITHOUT dragging the workout there too (and vice-versa).
    const msg = "昨日の夕食と今日の筋トレを記録して";
    const meal = resolveRelativeDateKeyForKind(msg, "meal", NOW);
    const workout = resolveRelativeDateKeyForKind(msg, "workout", NOW);
    expect(meal).toEqual({ dateKey: "2026-06-20", ambiguous: false }); // 昨日
    expect(workout).toEqual({ dateKey: "2026-06-21", ambiguous: false }); // 今日
  });

  it("the reverse order also attributes correctly (今日の筋トレと昨日の夕食)", () => {
    const msg = "今日の筋トレと昨日の夕食を記録";
    expect(resolveRelativeDateKeyForKind(msg, "meal", NOW).dateKey).toBe("2026-06-20");
    expect(resolveRelativeDateKeyForKind(msg, "workout", NOW).dateKey).toBe("2026-06-21");
  });

  it("a single consistent day word applies to whatever is logged (no conflict)", () => {
    const r = resolveRelativeDateKeyForKind("これ昨日の分で記入して", "meal", NOW);
    expect(r).toEqual({ dateKey: "2026-06-20", ambiguous: false });
  });

  it("no day word → today (dateKey null), not ambiguous", () => {
    expect(resolveRelativeDateKeyForKind("唐揚げ食べた、記録して", "meal", NOW)).toEqual({
      dateKey: null,
      ambiguous: false,
    });
  });

  it("no logging intent → today, not ambiguous (a casual mention never back-dates)", () => {
    expect(resolveRelativeDateKeyForKind("昨日は食べすぎたなあ", "meal", NOW)).toEqual({
      dateKey: null,
      ambiguous: false,
    });
  });

  it("conflicting days but the KIND isn't named → today + ambiguous (don't guess)", () => {
    // The message backdates a meal (昨日) and a workout (今日), but we ask about
    // SLEEP, which isn't mentioned — we must not drag either day onto sleep.
    const r = resolveRelativeDateKeyForKind("昨日の夕食と今日の筋トレを記録", "sleep", NOW);
    expect(r.dateKey).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("the same kind named twice with disagreeing days → today + ambiguous", () => {
    // "昨日の朝食と今日の夕食を記録" — two MEAL phrases on different days; we can't
    // pick one safely for a single meal block, so confirm instead of guessing.
    const r = resolveRelativeDateKeyForKind("昨日の朝食と今日の夕食を記録", "meal", NOW);
    expect(r.dateKey).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("一昨日 attributes to its kind too (most-specific marker honoured)", () => {
    const msg = "一昨日の筋トレと今日の昼食を記録";
    expect(resolveRelativeDateKeyForKind(msg, "workout", NOW).dateKey).toBe("2026-06-19");
    expect(resolveRelativeDateKeyForKind(msg, "meal", NOW).dateKey).toBe("2026-06-21");
  });

  it("prefers the explicit record-target day over a source day in 'same menu' requests", () => {
    const msg = "日付変わってしまいましたが、昨日の記録として、一昨日と全く同じメニューをやりましたので記録しといて";
    expect(resolveRelativeDateKeyForKind(msg, "meal", NOW)).toEqual({
      dateKey: "2026-06-20",
      ambiguous: false,
    });
  });

  it("does not let an explicit meal target date drag a separately dated workout", () => {
    const msg = "昨日の記録として夕食、今日の筋トレを記録して";
    expect(resolveRelativeDateKeyForKind(msg, "meal", NOW)).toEqual({
      dateKey: "2026-06-20",
      ambiguous: false,
    });
    expect(resolveRelativeDateKeyForKind(msg, "workout", NOW)).toEqual({
      dateKey: "2026-06-21",
      ambiguous: false,
    });
  });

  it("does not backdate a source-only 'same as yesterday' phrase when no record-target day is named", () => {
    const msg = "昨日と同じメニューを記録して";
    expect(resolveRelativeDateKeyForKind(msg, "meal", NOW)).toEqual({
      dateKey: null,
      ambiguous: false,
    });
  });

  it("still backdates a direct past meal phrase that is not a source comparison", () => {
    const msg = "昨日の夕食を記録して";
    expect(resolveRelativeDateKeyForKind(msg, "meal", NOW)).toEqual({
      dateKey: "2026-06-20",
      ambiguous: false,
    });
  });
});

describe("backdatedNote", () => {
  it("notes a past day, empty for today/null", () => {
    expect(backdatedNote("2026-06-20", NOW)).toContain("2026-06-20");
    expect(backdatedNote("2026-06-21", NOW)).toBe(""); // today → no note
    expect(backdatedNote(null, NOW)).toBe("");
  });
});

describe("ambiguousDateNote", () => {
  it("explains nothing was saved and how to disambiguate", () => {
    const note = ambiguousDateNote();
    expect(note).toContain("まだ保存していません");
    expect(note).toContain("昨日の夕食");
  });
});

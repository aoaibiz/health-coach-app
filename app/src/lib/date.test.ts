import { describe, it, expect } from "vitest";
import { formatTime, formatNowText, toDateKey, fromDateKey } from "./date";

describe("formatTime — HH:MM in local time, NaN-guarded", () => {
  it("formats a valid ISO timestamp to zero-padded HH:MM", () => {
    // Build the expected value from the same local-time getters formatTime uses,
    // so the assertion is timezone-independent (no hard-coded offset).
    const iso = "2026-06-18T08:05:00";
    const d = new Date(iso);
    const expected = `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
    expect(formatTime(iso)).toBe(expected);
  });

  it("returns null (never 'NaN:NaN') for an unparseable timestamp", () => {
    // Corrupt / old localStorage is a real source — Codex finding #3.
    expect(formatTime("not-a-date")).toBeNull();
    expect(formatTime("")).toBeNull();
    expect(formatTime("garbage timestamp")).toBeNull();
    // Whatever the input, a broken date never yields the literal "NaN:NaN".
    expect(formatTime("xxxx")).not.toBe("NaN:NaN");
  });

  it("mirrors readTodayContext: a NaN timestamp produces NO logged-time entry", () => {
    // readTodayContext (useChat) maps each meal's timestamp through formatTime and
    // drops entries whose time is null. Reproduce that exact logic over a mix of a
    // valid and a corrupt timestamp and assert the corrupt one is omitted (so no
    // "NaN:NaN" line ever reaches the prompt).
    const meals = [
      { type: "朝", timestamp: "2026-06-18T08:05:00" },
      { type: "昼", timestamp: "corrupt" }, // broken → must be dropped
    ];
    const logged: Array<{ type: string; time: string }> = [];
    for (const m of meals) {
      const time = formatTime(m.timestamp);
      if (time !== null) logged.push({ type: m.type, time });
    }
    expect(logged).toHaveLength(1);
    expect(logged[0].type).toBe("朝");
    expect(logged.some((e) => e.time.includes("NaN"))).toBe(false);
  });

  it("a workout time from a corrupt updatedAt resolves to undefined, not 'NaN:NaN'", () => {
    const updatedAt = "corrupt";
    const loggedWorkoutTime = formatTime(updatedAt) ?? undefined;
    expect(loggedWorkoutTime).toBeUndefined();
  });
});

describe("formatNowText / date keys — unchanged primitives still work", () => {
  it("formats the device-local date+time with the JP weekday", () => {
    const d = new Date(2026, 5, 18, 8, 10); // 2026-06-18 (Thu) 08:10 local
    expect(formatNowText(d)).toBe("2026-06-18(木) 08:10");
  });

  it("round-trips a date key", () => {
    expect(toDateKey(fromDateKey("2026-06-18"))).toBe("2026-06-18");
  });
});

import { afterEach, describe, it, expect } from "vitest";
import {
  deleteSleepForDate,
  formatDuration,
  isValidTime,
  loadSleepForDate,
  loadSleepLogs,
  saveSleepForDate,
  sleepDurationMin,
  summarizeSleep,
  timeToMinutes,
} from "./sleepLog";

function setWindowLocalStorage(values: Record<string, string> = {}) {
  const store = new Map(Object.entries(values));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("isValidTime / timeToMinutes", () => {
  it("accepts well-formed HH:MM, rejects garbage", () => {
    expect(isValidTime("23:00")).toBe(true);
    expect(isValidTime("7:05")).toBe(true);
    expect(isValidTime("00:00")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("12:60")).toBe(false);
    expect(isValidTime("abc")).toBe(false);
    expect(isValidTime("")).toBe(false);
    expect(isValidTime(null)).toBe(false);
  });

  it("converts HH:MM to minutes since midnight", () => {
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("07:30")).toBe(450);
    expect(timeToMinutes("23:00")).toBe(1380);
    expect(timeToMinutes("nope")).toBeNull();
  });
});

describe("sleepDurationMin — overnight-aware", () => {
  it("computes a normal overnight sleep (23:00 → 07:00 = 8h)", () => {
    expect(sleepDurationMin("23:00", "07:00")).toBe(480);
  });

  it("handles a late bedtime past midnight (01:30 → 09:00 = 7.5h)", () => {
    expect(sleepDurationMin("01:30", "09:00")).toBe(450);
  });

  it("handles a same-day nap (13:00 → 14:30 = 1.5h)", () => {
    expect(sleepDurationMin("13:00", "14:30")).toBe(90);
  });

  it("equal bedtime/wake → 0 (not a fabricated full 24h)", () => {
    expect(sleepDurationMin("22:00", "22:00")).toBe(0);
  });

  it("returns null when either time is unparseable (never a guess)", () => {
    expect(sleepDurationMin("nope", "07:00")).toBeNull();
    expect(sleepDurationMin("23:00", "")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats minutes as 時間/分; null → —", () => {
    expect(formatDuration(480)).toBe("8時間0分");
    expect(formatDuration(450)).toBe("7時間30分");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("storage — save / load / delete (one doc per day)", () => {
  it("saves and reads back a day's sleep with a derived duration", () => {
    setWindowLocalStorage();
    saveSleepForDate("2026-06-20", "23:00", "07:00", new Date("2026-06-21T00:00:00Z"));
    const log = loadSleepForDate("2026-06-20");
    expect(log).not.toBeNull();
    expect(log!.bedtime).toBe("23:00");
    expect(log!.wakeTime).toBe("07:00");
    expect(log!.durationMin).toBe(480); // derived, cached
    expect(log!.updatedAt).toBeTruthy();
  });

  it("last save for a day wins (upsert)", () => {
    setWindowLocalStorage();
    saveSleepForDate("2026-06-20", "23:00", "07:00");
    saveSleepForDate("2026-06-20", "00:00", "06:00");
    const log = loadSleepForDate("2026-06-20");
    expect(log!.bedtime).toBe("00:00");
    expect(log!.durationMin).toBe(360); // 6h
    // still one entry for the day.
    expect(Object.keys(loadSleepLogs())).toEqual(["2026-06-20"]);
  });

  it("delete removes the day's record", () => {
    setWindowLocalStorage();
    saveSleepForDate("2026-06-20", "23:00", "07:00");
    deleteSleepForDate("2026-06-20");
    expect(loadSleepForDate("2026-06-20")).toBeNull();
  });

  it("SSR-safe: no window → empty store, no throw", () => {
    expect(loadSleepLogs()).toEqual({});
    expect(loadSleepForDate("2026-06-20")).toBeNull();
  });
});

describe("summarizeSleep — coach context line", () => {
  it("renders range + length, or null when empty", () => {
    expect(
      summarizeSleep({ date: "d", bedtime: "23:00", wakeTime: "07:00", updatedAt: "x" }),
    ).toBe("23:00→07:00（8時間0分）");
    expect(summarizeSleep(null)).toBeNull();
    expect(
      summarizeSleep({ date: "d", bedtime: "", wakeTime: "", updatedAt: "x" }),
    ).toBeNull();
  });
});

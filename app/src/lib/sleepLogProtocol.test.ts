import { describe, it, expect } from "vitest";
import {
  SLEEP_LOG_OPEN,
  SLEEP_LOG_CLOSE,
  parseSleepReply,
  hasSleepLogBlock,
} from "./sleepLogProtocol";
import { applySleepLog } from "./chatSleepLog";
import { sleepDurationMin } from "./sleepLog";
import type { SleepLog } from "./types";

const block = (json: string) => `${SLEEP_LOG_OPEN}${json}${SLEEP_LOG_CLOSE}`;

describe("parseSleepReply — chat→睡眠 block parse + strip (拡張②)", () => {
  it("parses a valid 就寝/起床 pair and strips the block from the prose", () => {
    const raw = `睡眠を記録しておきました。\n${block('{"bedtime":"23:00","wakeTime":"07:00"}')}`;
    const { display, payload } = parseSleepReply(raw);
    expect(payload).toEqual({ bedtime: "23:00", wakeTime: "07:00", mode: "new" });
    // The raw JSON never reaches the bubble.
    expect(display).toBe("睡眠を記録しておきました。");
    expect(display).not.toContain(SLEEP_LOG_OPEN);
  });

  it("normalises a single-digit hour and full-width digits", () => {
    const { payload } = parseSleepReply(block('{"bedtime":"0:30","wakeTime":"６：４５"}'));
    expect(payload?.bedtime).toBe("0:30");
    expect(payload?.wakeTime).toBe("6:45");
  });

  it("drops a half-pair (one time missing) — never a half-logged sleep", () => {
    const { payload, display } = parseSleepReply(
      `起きた時刻も教えてください。${block('{"bedtime":"23:00"}')}`,
    );
    expect(payload).toBeNull();
    // Block still stripped even when invalid (no raw JSON leaks).
    expect(display).not.toContain(SLEEP_LOG_OPEN);
  });

  it("drops a garbage time (out of range)", () => {
    const { payload } = parseSleepReply(block('{"bedtime":"25:99","wakeTime":"07:00"}'));
    expect(payload).toBeNull();
  });

  it("no block → prose untouched, payload null", () => {
    const { display, payload } = parseSleepReply("まだ起きた時刻が分かりません。");
    expect(payload).toBeNull();
    expect(display).toBe("まだ起きた時刻が分かりません。");
  });

  it("hasSleepLogBlock detects a (even malformed) block", () => {
    expect(hasSleepLogBlock(block('{"bedtime":"23:00"}'))).toBe(true);
    expect(hasSleepLogBlock("ふつうの文章")).toBe(false);
  });
});

describe("applySleepLog — writes the day's record with a DERIVED length (no fabrication)", () => {
  it("upserts the day, caching the overnight-aware derived duration", () => {
    const now = new Date("2026-06-22T08:00:00.000Z");
    const { sleep, date } = applySleepLog(
      { bedtime: "23:00", wakeTime: "07:00", mode: "new" },
      { sleep: {}, date: "2026-06-22", now },
    );
    expect(date).toBe("2026-06-22");
    const rec = sleep["2026-06-22"];
    expect(rec.bedtime).toBe("23:00");
    expect(rec.wakeTime).toBe("07:00");
    // Length is DERIVED (23:00→07:00 = 480 min), not supplied by the model.
    expect(rec.durationMin).toBe(sleepDurationMin("23:00", "07:00"));
    expect(rec.durationMin).toBe(480);
  });

  it("replaces an existing record for the same day (one doc/day, last save wins)", () => {
    const existing: Record<string, SleepLog> = {
      "2026-06-22": { date: "2026-06-22", bedtime: "00:00", wakeTime: "06:00", updatedAt: "x" },
    };
    const { sleep } = applySleepLog(
      { bedtime: "22:30", wakeTime: "06:30" },
      { sleep: existing, date: "2026-06-22" },
    );
    expect(sleep["2026-06-22"].bedtime).toBe("22:30");
    expect(sleep["2026-06-22"].durationMin).toBe(480); // 22:30→06:30
  });
});

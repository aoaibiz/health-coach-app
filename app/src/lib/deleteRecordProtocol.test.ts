import { describe, expect, it } from "vitest";
import {
  DELETE_RECORD_CLOSE,
  DELETE_RECORD_OPEN,
  parseDeleteRecordReply,
} from "./deleteRecordProtocol";

describe("parseDeleteRecordReply", () => {
  it("strips a delete action block and parses the structured target", () => {
    const raw = `了解です。\n${DELETE_RECORD_OPEN}{"kind":"workout","date":"2026-06-28","scope":"day","names":["懸垂"]}${DELETE_RECORD_CLOSE}`;

    const parsed = parseDeleteRecordReply(raw);

    expect(parsed.display).toBe("了解です。");
    expect(parsed.hadBlock).toBe(true);
    expect(parsed.payload).toEqual({
      kind: "workout",
      date: "2026-06-28",
      scope: "day",
      names: ["懸垂"],
    });
  });

  it("rejects invalid dates instead of executing a vague delete", () => {
    const raw = `${DELETE_RECORD_OPEN}{"kind":"workout","date":"今日","scope":"day"}${DELETE_RECORD_CLOSE}`;

    const parsed = parseDeleteRecordReply(raw);

    expect(parsed.payload).toBeNull();
    expect(parsed.hadBlock).toBe(true);
  });

  it("strips a malformed delete block without a closing marker from the visible display", () => {
    const raw = `確認します。${DELETE_RECORD_OPEN}{"kind":"workout","date":"2026-06-28","scope":"day"}`;

    const parsed = parseDeleteRecordReply(raw);

    expect(parsed.payload).toBeNull();
    expect(parsed.display).toBe("確認します。");
    expect(parsed.hadBlock).toBe(true);
  });

  it("strips all delete blocks and keeps the first valid parsed payload", () => {
    const raw = [
      "了解です。",
      `${DELETE_RECORD_OPEN}{"kind":"workout","date":"今日","scope":"day"}${DELETE_RECORD_CLOSE}`,
      "処理します。",
      `${DELETE_RECORD_OPEN}{"kind":"meal","date":"2026-06-28","scope":"latest"}${DELETE_RECORD_CLOSE}`,
    ].join("");

    const parsed = parseDeleteRecordReply(raw);

    expect(parsed.display).toBe("了解です。処理します。");
    expect(parsed.hadBlock).toBe(true);
    expect(parsed.payload).toEqual({
      kind: "meal",
      date: "2026-06-28",
      scope: "latest",
    });
  });

  it("strips a stray close marker and treats it as malformed delete output", () => {
    const parsed = parseDeleteRecordReply(`了解です。${DELETE_RECORD_CLOSE}`);

    expect(parsed.payload).toBeNull();
    expect(parsed.display).toBe("了解です。");
    expect(parsed.hadBlock).toBe(true);
  });

  it("distinguishes an invalid structured delete block from no block so callers can suppress fallback deletes", () => {
    const parsed = parseDeleteRecordReply(
      `確認します。${DELETE_RECORD_OPEN}{"kind":"workout","date":"今日","scope":"day"}${DELETE_RECORD_CLOSE}`,
    );

    expect(parsed.display).toBe("確認します。");
    expect(parsed.payload).toBeNull();
    expect(parsed.hadBlock).toBe(true);
  });

  it("strips orphan delete JSON before a close marker so malformed output cannot leak", () => {
    const parsed = parseDeleteRecordReply(
      `確認します。{"kind":"workout","date":"2026-06-28","scope":"day"}${DELETE_RECORD_CLOSE}`,
    );

    expect(parsed.display).toBe("確認します。");
    expect(parsed.payload).toBeNull();
    expect(parsed.hadBlock).toBe(true);
  });
});

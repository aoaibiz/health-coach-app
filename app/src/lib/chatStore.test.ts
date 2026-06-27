import { describe, it, expect } from "vitest";
import {
  sameChatHistory,
  sanitizeHistory,
  toWireMessages,
  type ChatMessage,
} from "./chatStore";

function msg(role: "user" | "assistant", content: string, i = 0): ChatMessage {
  return { id: `id-${i}`, role, content, createdAt: "2026-06-17T00:00:00.000Z" };
}

describe("sameChatHistory — live-restore no-op guard", () => {
  it("true when ids + content match pairwise (already showing it → no re-render)", () => {
    const a = [msg("user", "hi", 1), msg("assistant", "yo", 2)];
    const b = [msg("user", "hi", 1), msg("assistant", "yo", 2)];
    expect(sameChatHistory(a, b)).toBe(true);
  });
  it("false on different length (server merge added a turn → restore it)", () => {
    const a = [msg("user", "hi", 1)];
    const b = [msg("user", "hi", 1), msg("assistant", "yo", 2)];
    expect(sameChatHistory(a, b)).toBe(false);
  });
  it("false when an id or content differs", () => {
    expect(sameChatHistory([msg("user", "hi", 1)], [msg("user", "hi", 9)])).toBe(false);
    expect(sameChatHistory([msg("user", "hi", 1)], [msg("user", "bye", 1)])).toBe(false);
  });
  it("true for two empty histories", () => {
    expect(sameChatHistory([], [])).toBe(true);
  });
});

describe("sanitizeHistory — defensive load", () => {
  it("keeps only well-formed ChatMessages", () => {
    const raw = [
      msg("user", "hi", 1),
      { id: "x", role: "system", content: "no", createdAt: "t" }, // bad role
      { id: 1, role: "user", content: "no", createdAt: "t" }, // bad id
      { role: "user", content: "missing id", createdAt: "t" }, // missing id
      msg("assistant", "yo", 2),
    ];
    expect(sanitizeHistory(raw)).toEqual([msg("user", "hi", 1), msg("assistant", "yo", 2)]);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeHistory(null)).toEqual([]);
    expect(sanitizeHistory("nope")).toEqual([]);
    expect(sanitizeHistory({})).toEqual([]);
  });

  it("caps to the last 200 entries", () => {
    const many = Array.from({ length: 250 }, (_, i) => msg("user", `m${i}`, i));
    const out = sanitizeHistory(many);
    expect(out).toHaveLength(200);
    expect(out[0].content).toBe("m50");
    expect(out[199].content).toBe("m249");
  });
});

describe("toWireMessages — strip to role+content, keep recent window", () => {
  it("drops id/createdAt and keeps order", () => {
    const wire = toWireMessages([msg("user", "a", 1), msg("assistant", "b", 2)]);
    expect(wire).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });

  it("keeps only the last `limit` turns", () => {
    const many = Array.from({ length: 30 }, (_, i) => msg("user", `m${i}`, i));
    const wire = toWireMessages(many, 5);
    expect(wire).toHaveLength(5);
    expect(wire[0].content).toBe("m25");
    expect(wire[4].content).toBe("m29");
  });
});

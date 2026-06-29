import { describe, expect, it } from "vitest";
import { isTerminalPutRejection } from "./syncData";
import { AuthApiError } from "./authApi";

// Fix: a server-rejected PUT (HTTP 400 — e.g. the section blob exceeds the size
// cap) must NOT be retried-then-silently-swallowed. attemptPush surfaces a visible
// SYNC_ERROR_EVENT for terminal rejections and only RETRIES the transient ones.
// This proves the classifier that decides which path a failure takes.
describe("isTerminalPutRejection", () => {
  it("treats a 400 (validation / size cap) as TERMINAL → surface, don't retry", () => {
    expect(isTerminalPutRejection(new AuthApiError(400, "データの保存に失敗しました"))).toBe(true);
  });

  it("treats session / rate / server errors as NON-terminal → retry silently", () => {
    expect(isTerminalPutRejection(new AuthApiError(401, "x"))).toBe(false);
    expect(isTerminalPutRejection(new AuthApiError(403, "x"))).toBe(false);
    expect(isTerminalPutRejection(new AuthApiError(429, "x"))).toBe(false);
    expect(isTerminalPutRejection(new AuthApiError(503, "x"))).toBe(false);
  });

  it("treats a network failure (no status — e.g. a fetch TypeError) as NON-terminal", () => {
    expect(isTerminalPutRejection(new TypeError("Failed to fetch"))).toBe(false);
    expect(isTerminalPutRejection(undefined)).toBe(false);
    expect(isTerminalPutRejection({ status: 400 })).toBe(false); // not an AuthApiError instance.
  });
});

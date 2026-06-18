// MockChatProvider — used by chat tests (PRD §8: never hit a real API/CLI in
// tests). Deterministic: echoes a canned reply (or one driven by the test) and
// can be forced to throw to exercise the handler's honest-failure path. It does
// NOT call codex. It mirrors the ChatProvider contract exactly.

import type { ChatProvider } from "./chat";
import type { ChatContext, ChatTurn } from "./chat-prompt";

export interface MockChatOptions {
  /** Canned reply text. Defaults to a fixed friendly line. */
  reply?: string;
  /** Force a rejection, to exercise the handler's 502 path. */
  throwError?: boolean;
}

export class MockChatProvider implements ChatProvider {
  /** The last input the provider saw, so tests can assert on shaping. */
  public lastInput: { messages: ChatTurn[]; context?: ChatContext } | null = null;

  constructor(private readonly opts: MockChatOptions = {}) {}

  async reply(input: { messages: ChatTurn[]; context?: ChatContext }): Promise<string> {
    this.lastInput = input;
    if (this.opts.throwError) {
      throw new Error("MockChatProvider: simulated provider failure");
    }
    return this.opts.reply ?? "こんにちは！今日も一緒にがんばろう。";
  }
}

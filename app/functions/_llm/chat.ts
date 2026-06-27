// CodexChatProvider — the chat-coach adapter (Codex CLI subscription path,
// PRD §F6/Phase 5). Mirrors CodexProvider (functions/_llm/codex.ts) EXACTLY for
// spawn safety: args-array spawn (no shell string), stdin CLOSED, --sandbox
// read-only, cwd = a fresh private temp dir, model_reasoning_effort=none, -o
// <outfile> to capture the agent's final message, timeout + SIGKILL, and the
// temp dir is always cleaned up. No paid API, no API key.
//
// The ONLY behavioural difference from the meal path: the model returns a normal
// free-text assistant message (the coach's reply), NOT JSON. We prefer the -o
// outfile (banner-free), strip any codex preamble, and fall back to stdout.
//
// SECURITY: the user's chat text is untrusted (possible prompt injection). The
// prompt (built by chat-prompt.ts) tells the model to ignore embedded commands;
// the read-only sandbox means any model-issued shell command cannot run/write;
// the temp cwd isolates the process; we never log the conversation or secrets.

import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildChatPrompt, type ChatContext, type ChatTurn } from "./chat-prompt";

/** Default per-call timeout (ms). Codex chat can take ~10-15s; on timeout we throw. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default chat model — overridable via env (CHAT_MODEL, then MEAL_VISION_MODEL). */
const DEFAULT_CHAT_MODEL = "claude-haiku-4-5";

export interface ChatProvider {
  /** Return the coach's reply text for the given conversation + context. */
  reply(input: { messages: ChatTurn[]; context?: ChatContext }): Promise<string>;
}

/** Result of running the codex CLI for a chat turn. */
export interface CodexChatRunResult {
  /** Whatever the CLI emitted on stdout — banner + preamble + the reply. */
  stdout: string;
  /** If the runner used `-o <file>`, the captured final agent message. */
  lastMessage?: string;
}

/**
 * Test seam: a function that "runs codex" given the prompt and resolves with the
 * CLI output. The default implementation spawns the real binary; tests inject a
 * fake so the real CLI is NEVER called.
 */
export type CodexChatRunner = (args: {
  binary: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  /** Path codex should write its final agent message to (-o). */
  outFile: string;
  /** Private per-call working directory for the codex process. */
  cwd: string;
}) => Promise<CodexChatRunResult>;

export interface CodexChatProviderConfig {
  /** Codex binary; defaults to CODEX_BIN env, else `codex` on PATH. */
  binary?: string;
  /** Model id; defaults to CHAT_MODEL || MEAL_VISION_MODEL || claude-haiku-4-5. */
  model?: string;
  /** Per-call timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Test seam — inject a fake runner so tests never spawn the real CLI. */
  runner?: CodexChatRunner;
}

/**
 * Strip codex's banner/preamble from a raw stdout dump and return the assistant
 * reply text. Used only as the fallback when the -o outfile is unavailable.
 * The stdout stream can echo the full prompt as a `user` block, so prefer only
 * the text after the last standalone `codex` marker and before `tokens used`.
 */
export function extractReplyFromCodexOutput(text: string): string {
  const raw = text.replace(/\r\n/g, "\n");
  const rawLines = raw.split("\n");

  let tokenIdx = rawLines.findIndex((line) => /^tokens used(?:\s*:.*)?$/i.test(line.trim()));
  if (tokenIdx < 0) tokenIdx = rawLines.length;

  let startIdx = -1;
  for (let i = 0; i < tokenIdx; i++) {
    if (/^codex$/i.test(rawLines[i].trim())) startIdx = i + 1;
  }

  let body = startIdx >= 0 ? rawLines.slice(startIdx, tokenIdx) : rawLines.slice(0, tokenIdx);
  if (startIdx < 0) {
    // No explicit assistant marker: drop only the top banner/header. Do not use
    // the final dashed line blindly when a `user` prompt echo follows it.
    let lastHeaderDashIdx = -1;
    for (let i = 0; i < body.length; i++) {
      if (/^-{3,}\s*$/.test(body[i])) lastHeaderDashIdx = i;
      if (/^user$/i.test(body[i].trim())) break;
    }
    if (lastHeaderDashIdx >= 0) body = body.slice(lastHeaderDashIdx + 1);
  }

  // Drop codex log lines like "[2026-06-17T..] tokens used: 1234" and obvious
  // header key/value lines (model:/provider:/workdir:) that may precede the reply.
  const cleaned = body
    .filter((l) => !/^\[[^\]]+\]/.test(l.trim()))
    .filter((l) => !/^(workdir|model|provider|reasoning|approval|sandbox)\s*:/i.test(l.trim()))
    .join("\n")
    .trim();

  const result = cleaned || raw.trim();
  if (!result) {
    throw new Error("CodexChatProvider: empty reply from codex output");
  }
  if (looksLikePromptEcho(result)) {
    throw new Error("CodexChatProvider: stdout contained prompt echo, no assistant reply");
  }
  return result;
}

function looksLikePromptEcho(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n");
  return (
    /^user\n/i.test(normalized.trimStart()) ||
    (
      normalized.includes("健康マン") &&
      (
        normalized.includes("【守るべきルール】") ||
        normalized.includes("カロリーや栄養素の数値を捏造しないでください") ||
        normalized.includes("あなたは医療従事者ではありません")
      )
    )
  );
}

/** The real runner: spawns the codex CLI with an args array (no shell string). */
const defaultRunner: CodexChatRunner = ({ binary, prompt, model, timeoutMs, outFile, cwd }) => {
  const maxBuffer = 16 * 1024 * 1024;
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    // NOTE: do NOT pass `-m <anthropic model>` — codex runs on the ChatGPT
    // subscription (gpt-5.5). An Anthropic model id (e.g. claude-haiku-4-5)
    // is rejected with HTTP 400 and produces NO -o output. Use codex's default.
    "-c",
    "model_reasoning_effort=none",
    "-o",
    outFile,
    prompt,
  ];
  void model;
  return new Promise<CodexChatRunResult>((resolve, reject) => {
    // stdin is CLOSED ("ignore") — the untrusted prompt can never be a stdin
    // injection vector, identical to the meal path.
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("CODEX_TIMEOUT"));
    }, timeoutMs);

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(err);
    };

    const collect = (chunks: Buffer[], bytes: number, chunk: Buffer | string): number => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextBytes = bytes + buf.length;
      if (nextBytes > maxBuffer) {
        settleReject(new Error("CODEX_OUTPUT_TOO_LARGE"));
        return bytes;
      }
      chunks.push(buf);
      return nextBytes;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBytes = collect(stdoutChunks, stdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes = collect(stderrChunks, stderrBytes, chunk);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT → codex not installed/on PATH → server maps to 503.
      if (err.code === "ENOENT") {
        settleReject(new Error("CODEX_NOT_FOUND"));
        return;
      }
      settleReject(err);
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const result: CodexChatRunResult = {
        stdout: code === 0 ? stdout : `${stdout}\n${stderr}`,
      };
      try {
        result.lastMessage = await readFile(outFile, "utf8");
      } catch {
        // Fall back to stdout when codex did not create/readable -o output.
      }
      resolve(result);
    });
  });
};

function resolveModel(cfgModel?: string): string {
  return (
    cfgModel ||
    process.env.CHAT_MODEL ||
    process.env.MEAL_VISION_MODEL ||
    DEFAULT_CHAT_MODEL
  );
}

export class CodexChatProvider implements ChatProvider {
  private readonly binary: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly runner: CodexChatRunner;

  constructor(cfg: CodexChatProviderConfig = {}) {
    this.binary = cfg.binary || process.env.CODEX_BIN || "codex";
    this.model = resolveModel(cfg.model);
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runner = cfg.runner ?? defaultRunner;
  }

  async reply(input: { messages: ChatTurn[]; context?: ChatContext }): Promise<string> {
    if (!input.messages || input.messages.length === 0) {
      throw new Error("CodexChatProvider: at least one message required");
    }

    const prompt = buildChatPrompt(input.messages, input.context);

    let dir: string | null = null;
    let outFile = "";
    try {
      // Fresh private temp dir = the codex cwd; also holds the -o output file.
      dir = await mkdtemp(join(tmpdir(), "chat-codex-"));
      await chmod(dir, 0o700);
      outFile = join(dir, "last-message.txt");
      await writeFile(outFile, "", { mode: 0o600 });

      const result = await this.runner({
        binary: this.binary,
        prompt,
        model: this.model,
        timeoutMs: this.timeoutMs,
        outFile,
        cwd: dir,
      });

      // Prefer the captured final agent message (banner-free) exactly as codex
      // wrote it; fall back to scanning stdout only when the outfile is empty.
      if (result.lastMessage && result.lastMessage.trim()) {
        return result.lastMessage.trim();
      }
      return extractReplyFromCodexOutput(result.stdout);
    } finally {
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {
          /* best-effort cleanup; do not mask the real error */
        });
      }
    }
  }
}

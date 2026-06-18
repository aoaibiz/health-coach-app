// CodexProvider — the ACTIVE meal-vision adapter (Codex CLI subscription path).
//
// No paid API, no API key: we shell out to the locally-installed Codex CLI
// (GPT-5.5 vision via the OpenAI ChatGPT subscription) using `codex exec -i`.
//
// The model identifies each food and tags it with a SOURCE so we ALWAYS return
// a number with its provenance (anti-fabrication = "show the source", not "hide
// what's not in the DB"):
//   - "db"      → standard whole food. Returns name + grams ONLY; the MEXT DB
//                 (functions/_lib/ground.ts) supplies the authoritative numbers.
//   - "label"   → packaged product whose photo shows a nutrition label. Returns
//                 name + grams + the kcal/PFC READ FROM THE LABEL (for that grams).
//   - "estimate"→ not a standard food and no readable label. Returns name + grams
//                 + a general-knowledge kcal/PFC estimate (clearly marked 推定).
// The model must NOT claim "label" unless a label is actually visible.
// We force the answer into a single fenced ```json block and parse the LAST
// schema-matching object, so codex's banner/preamble prose is ignored.
//
// SECURITY: the uploaded image is untrusted (possible prompt injection). We
//   - write it to a private temp file and pass it via `-i <file>` (args array,
//     never a shell string — no interpolation of attacker bytes);
//   - run `--sandbox read-only` so any model-issued shell command cannot write;
//   - instruct the model to run NO commands and output only JSON;
//   - parse ONLY the JSON block and ignore everything else;
//   - clean up the temp file in all cases and never log secrets/image bytes.
//
// This runs ONLY under Node (server/index.mjs), NOT the Cloudflare Pages
// (Workers) runtime — it uses node:child_process / node:fs. A member's CF Pages
// deploy (functions/api/analyze-meal.ts → onRequestPost) is ALWAYS own-key and
// must never import this file; it selects the fetch-native Gemini provider via
// the worker-safe functions/_llm/select-own. The shared meal PROMPT + parser this
// provider uses live in the Node-free functions/_llm/meal-extract (re-exported
// here) so both paths share the identical anti-fabrication contract.

import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalyzeInput, AnalyzeResult, MealVisionProvider } from "./provider";
import type { IdentifiedDish } from "../_lib/ground";
// The meal PROMPT + the robust dish JSON parser live in a Node-FREE module
// (./meal-extract) so the own-key Gemini provider (and a member's Cloudflare
// Pages bundle) can reuse the EXACT same prompt + parser WITHOUT pulling this
// file's node:child_process / node:fs imports into the Workers runtime. We
// re-export them here so the Node Codex path keeps the same import surface.
import {
  MEAL_PROMPT,
  PROMPT,
  extractDishesFromCodexOutput,
} from "./meal-extract";
export { MEAL_PROMPT, PROMPT, extractDishesFromCodexOutput };

/** Default per-call timeout (ms). Codex vision can be slow; on timeout we throw. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Generated-by label surfaced in the UI for transparency. */
const GENERATED_BY = "codex-cli (gpt-5.5)";

/** Result of running the codex CLI: combined stdout (and any captured last msg). */
export interface CodexRunResult {
  /** Whatever the CLI emitted — banner + preamble + the json block. */
  stdout: string;
  /**
   * If the runner used `-o <file>` to capture the agent's final message, this
   * is that file's content. Optional; parsing falls back to stdout when absent.
   */
  lastMessage?: string;
}

/**
 * Test seam: a function that "runs codex" given an image path + prompt and
 * resolves with the CLI output. The default implementation spawns the real
 * binary; tests inject a fake so the real CLI is NEVER called.
 */
export type CodexRunner = (args: {
  binary: string;
  /**
   * First image path (the single-photo case), or "" for a text-only meal. Kept
   * for backward compatibility; the canonical list is `imagePaths` below (which
   * always contains the same paths, 0..N). The default runner emits one `-i` per
   * entry of `imagePaths`.
   */
  imagePath: string;
  /** All image paths for this ONE meal (multi-photo). [] for text-only. */
  imagePaths: string[];
  prompt: string;
  timeoutMs: number;
  /** Path codex should write its final agent message to (-o). */
  outFile: string;
  /** Private per-call working directory for the codex process. */
  cwd: string;
}) => Promise<CodexRunResult>;

export interface CodexProviderConfig {
  /** Codex binary; defaults to CODEX_BIN env, else `codex` on PATH. */
  binary?: string;
  /** Per-call timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Test seam — inject a fake runner so tests never spawn the real CLI. */
  runner?: CodexRunner;
}

/** The real runner: spawns the codex CLI with an args array (no shell string). */
const defaultRunner: CodexRunner = ({ binary, imagePath, imagePaths, prompt, timeoutMs, outFile, cwd }) => {
  const maxBuffer = 16 * 1024 * 1024;
  // Attach EVERY image of the meal as its own `-i` flag (codex `-i` is repeatable
  // and the model sees them all in one call — verified: a 2-image run returns both
  // in order). Fall back to the legacy single `imagePath` when no list is given.
  const paths = imagePaths && imagePaths.length > 0 ? imagePaths : imagePath ? [imagePath] : [];
  const imageArgs = paths.flatMap((p) => ["-i", p]);
  const args = [
    "exec",
    // Attach the image(s) ONLY when we have any (text-only meals skip -i).
    ...imageArgs,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    "model_reasoning_effort=none",
    "-o",
    outFile,
    prompt,
  ];
  return new Promise<CodexRunResult>((resolve, reject) => {
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
      // ENOENT → codex not installed/on PATH. Surface a recognizable error
      // so the server can map it to a 503 ("analysis unavailable").
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
      const result: CodexRunResult = {
        // Non-zero exit: still try to parse stdout (codex may have printed the
        // JSON before exiting non-zero). Pass stdout/stderr through.
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

export class CodexProvider implements MealVisionProvider {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly runner: CodexRunner;

  constructor(cfg: CodexProviderConfig = {}) {
    this.binary = cfg.binary || process.env.CODEX_BIN || "codex";
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runner = cfg.runner ?? defaultRunner;
  }

  async analyzeMeal(input: AnalyzeInput): Promise<AnalyzeResult> {
    // Normalise the single/multi image inputs into ONE ordered list of base64
    // images for this meal. `imageBase64List` (multi) takes precedence; a lone
    // `imageBase64` is the 1-element case. Empty/blank entries are dropped so a
    // stray "" never spawns a bogus `-i`.
    const base64Images = (
      input.imageBase64List && input.imageBase64List.length > 0
        ? input.imageBase64List
        : input.imageBase64
          ? [input.imageBase64]
          : []
    ).filter((b) => typeof b === "string" && b.length > 0);

    if (base64Images.length === 0 && !input.text) {
      throw new Error("CodexProvider: image or text required");
    }

    // Build the per-call prompt; optional text is appended (it's our own server
    // text, not the untrusted image — still treated as a hint only).
    const prompt = input.text
      ? `${PROMPT}\n\n参考の説明文: ${input.text}`
      : PROMPT;

    // Image paths; one temp file per image of the meal (0..N).
    let dir: string | null = null;
    const imagePaths: string[] = [];
    let outFile = "";

    try {
      // Always need a temp dir for the -o output file; also for the image(s).
      dir = await mkdtemp(join(tmpdir(), "meal-codex-"));
      await chmod(dir, 0o700);
      outFile = join(dir, "last-message.txt");
      await writeFile(outFile, "", { mode: 0o600 });

      for (let i = 0; i < base64Images.length; i++) {
        const buf = Buffer.from(base64Images[i], "base64");
        if (buf.length === 0) {
          throw new Error("CodexProvider: empty/invalid image data");
        }
        // Single-photo keeps the legacy "meal.jpg" name; multi-photo uses distinct
        // "meal-N.jpg" so each `-i` points at a separate file.
        const name = base64Images.length === 1 ? "meal.jpg" : `meal-${i}.jpg`;
        const p = join(dir, name);
        await writeFile(p, buf, { mode: 0o600 });
        imagePaths.push(p);
      }

      const result = await this.runner({
        binary: this.binary,
        // Legacy single-path field (first image, "" when none); imagePaths is the
        // canonical list the default runner iterates to emit one -i per image.
        imagePath: imagePaths[0] ?? "",
        imagePaths,
        prompt,
        timeoutMs: this.timeoutMs,
        outFile,
        cwd: dir,
      });

      // Prefer the captured final agent message (the model's actual answer,
      // banner-free) when it parses; otherwise fall back to scanning full
      // stdout. Both ignore banner/preamble noise via the robust extractor.
      let dishes: IdentifiedDish[] | null = null;
      if (result.lastMessage) {
        try {
          dishes = extractDishesFromCodexOutput(result.lastMessage);
        } catch {
          dishes = null; // fall through to stdout
        }
      }
      if (!dishes) {
        dishes = extractDishesFromCodexOutput(result.stdout);
      }
      return { dishes, generatedBy: GENERATED_BY };
    } finally {
      // Always clean up the temp dir (image + out file). Never log its bytes.
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {
          /* best-effort cleanup; do not mask the real error */
        });
      }
    }
  }
}

// Structured auto-log protocol for SLEEP (chat→睡眠 flow). The sleep twin of
// workoutLogProtocol.ts: when the coach has gathered a 就寝/起床 pair, its reply
// carries — alongside the natural prose — a single fenced sentinel block with the
// bedtime + wakeTime. The client detects the block, parses it, STRIPS it from the
// displayed text (the user only ever sees natural Japanese — never raw JSON), and
// writes it via the EXISTING sleepLog store (which DERIVES the duration — the
// model never supplies a sleep length, so there is nothing to fabricate).
//
// FABRICATION SAFETY: the block carries ONLY the two clock times the user stated.
// The sleep LENGTH is computed by sleepLog.sleepDurationMin (overnight-aware), not
// read from the model. An incomplete/garbage pair is dropped (no half-logged
// sleep), exactly like the meal/workout parsers.
//
// PURE + framework-free (no DOM, no network) so the parse/strip is unit-tested in
// isolation and reused verbatim by the chat client.

import { parseLogMode, type LogMode } from "./mealLogProtocol";
import { isValidTime } from "./sleepLog";

/** The sentinel that fences the structured sleep block (mirrors MEAL_LOG/WORKOUT_LOG). */
export const SLEEP_LOG_OPEN = "«SLEEP_LOG»";
export const SLEEP_LOG_CLOSE = "«/SLEEP_LOG»";

/** The parsed sleep auto-log payload. */
export interface SleepLogPayload {
  /** 就寝時刻, local "HH:MM" (validated). */
  bedtime: string;
  /** 起床時刻, local "HH:MM" (validated). */
  wakeTime: string;
  /** new = log/replace today's (default); correct = same effect (one doc/day). */
  mode?: LogMode;
}

/** The result of scanning a coach reply for a SLEEP_LOG block. */
export interface ParsedSleepReply {
  display: string;
  payload: SleepLogPayload | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the FIRST sleep sentinel block (non-greedy), capturing its inner text. */
const BLOCK_RE = new RegExp(
  `${escapeRegExp(SLEEP_LOG_OPEN)}([\\s\\S]*?)${escapeRegExp(SLEEP_LOG_CLOSE)}`,
);

/** Normalise a raw clock string to "HH:MM" when valid, else null. Accepts a
 *  single-digit hour ("7:30") and full-width digits the model might emit. */
function cleanTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // NFKC folds full-width digits/colon to ASCII so "２３：００" still parses.
  const t = raw.normalize("NFKC").trim();
  return isValidTime(t) ? t : null;
}

/** Parse the inner JSON of a sleep block, tolerant of a ```json fence. Returns a
 *  payload only when BOTH times are valid (no half-logged sleep). */
function parseBlockBody(body: string): SleepLogPayload | null {
  let text = body.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(text);
  if (fence) text = fence[1].trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as { bedtime?: unknown; wakeTime?: unknown; mode?: unknown };
  const bedtime = cleanTime(r.bedtime);
  const wakeTime = cleanTime(r.wakeTime);
  // Both times are REQUIRED — the duration is derived from the pair. A missing /
  // malformed time means there's nothing honest to log.
  if (!bedtime || !wakeTime) return null;
  return { bedtime, wakeTime, mode: parseLogMode(r.mode) };
}

/**
 * Scan a raw coach reply for the SLEEP_LOG block. Returns the display text with
 * the block removed plus the parsed payload. ALWAYS strips the block — even when
 * malformed — so raw JSON never reaches the user. No block → display is the input
 * trimmed and payload is null.
 */
export function parseSleepReply(raw: string): ParsedSleepReply {
  const match = BLOCK_RE.exec(raw);
  if (!match) return { display: raw.trim(), payload: null };
  const payload = parseBlockBody(match[1]);
  const display = raw.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { display, payload };
}

/** True when a reply contains a (possibly malformed) sleep block. */
export function hasSleepLogBlock(raw: string): boolean {
  return BLOCK_RE.test(raw);
}

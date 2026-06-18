// Structured auto-log protocol (marquee chat→食事 flow).
//
// THE SIDE CHANNEL. When the super-trainer (健康マン) has gathered enough to log
// today's meal, its reply carries — alongside the natural prose — a single fenced
// sentinel block describing WHICH items to log (name + grams + qty + the model's
// own source tag). The client detects that block, parses it, STRIPS it from the
// displayed text (the user only ever sees natural Japanese — never raw JSON), and
// re-grounds every item through the SAME grounded pipeline the /meal page uses
// (functions/_lib/ground via foodGrounding.groundMealLogItems).
//
// ┌─ FABRICATION SAFETY (the hard rule) ──────────────────────────────────────┐
// │ The block carries only items (name/grams/qty) + a source tag. The kcal/PFC │
// │ that get LOGGED are computed by the grounded code from those items, NOT     │
// │ read from anything the model wrote:                                         │
// │   - db       → recomputed from the official MEXT per-100g basis;            │
// │   - label/estimate → the model's anchor numbers, sanitised + labelled 推定/ │
// │                 ラベル; an estimate is NEVER presented as a 公式DB value.    │
// │ This module ONLY parses + strips; it carries the model's numbers through as │
// │ a *candidate anchor* for label/estimate items, and the grounding layer (not │
// │ this module) decides what becomes authoritative. See foodGrounding.ts.      │
// └────────────────────────────────────────────────────────────────────────────┘
//
// PURE + framework-free (no DOM, no network) so the parse/strip is unit-tested
// in isolation and reused verbatim by the chat client.

import type { MealType, NutritionSourceKind } from "./types";

/** The sentinel that fences the structured block. Chosen so it never appears in
 *  natural Japanese prose (guillemets + an uppercase tag). The model is told to
 *  emit it EXACTLY; we match it case-sensitively. */
export const MEAL_LOG_OPEN = "«MEAL_LOG»";
export const MEAL_LOG_CLOSE = "«/MEAL_LOG»";

/** One item the model asks us to log. Numbers (when present) are CANDIDATE
 *  anchors only — the grounding layer decides what is authoritative. */
export interface MealLogItemPayload {
  name: string;
  /** Per-unit edible grams (the model's portion estimate). */
  grams: number;
  /** Quantity multiplier (e.g. 2杯). Defaults to 1. */
  qty?: number;
  /** The model's source tag. db = standard food (DB authoritative, numbers
   *  ignored); label/estimate = the model's anchor numbers are used + labelled. */
  source?: NutritionSourceKind;
  /** Candidate anchor numbers for label/estimate items (ignored for db). */
  kcal?: number;
  protein_g?: number;
  fat_g?: number;
  carb_g?: number;
}

/**
 * Whether this block logs a NEW entry or CORRECTS the one it just logged.
 * Shared by meals and workouts — the explicit dedupe signal that replaces the
 * old in-memory "reset only on new photo" heuristic:
 *   - "new"     (default): the model is logging a distinct meal → APPEND.
 *   - "correct": the user explicitly asked to fix the entry the coach just
 *     logged → UPDATE the most-recent logged entry of that kind in place.
 * Defaulting to "new" is the safe direction: an omitted/unknown mode can never
 * silently overwrite a previous meal (the over-merge bug); a correction must be
 * an explicit, deliberate signal.
 */
export type LogMode = "new" | "correct";

/** The full parsed auto-log payload. */
export interface MealLogPayload {
  items: MealLogItemPayload[];
  /** Optional meal slot the model inferred (朝/昼/夕/間食). Defaulted by the client. */
  type?: MealType;
  /** new = append a distinct meal (default); correct = update the last logged meal. */
  mode?: LogMode;
}

const MEAL_TYPE_SET = new Set<MealType>(["朝", "昼", "夕", "間食"]);

/** Coerce a raw mode value into a LogMode; anything but "correct" → "new" (safe default). */
export function parseLogMode(v: unknown): LogMode {
  return v === "correct" ? "correct" : "new";
}

/** A finite, non-negative number or undefined (drops garbage/negatives). */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function isSourceKind(v: unknown): v is NutritionSourceKind {
  return v === "db" || v === "label" || v === "estimate";
}

/** Coerce one raw item into a clean MealLogItemPayload, or null if unusable. */
function toItem(raw: unknown): MealLogItemPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  // A usable NAME is the only thing required: a food the user named must always
  // reach grounding. Without a name there's nothing to ground → drop the garbage.
  if (!name) return null;
  // grams is a CANDIDATE portion, not a gate. Missing / ≤0 / NaN on a named item
  // is normalised to 0 (a number, so the type holds); the grounding layer's
  // resolveGrams then defaults 0 → 100g, so a named food logs a real calorie
  // (DB basis × default) instead of being silently dropped. We do NOT duplicate
  // the portion constant here — the single default lives in foodGrounding.ts.
  const grams = num(r.grams) ?? 0;
  const item: MealLogItemPayload = { name, grams };
  const qty = num(r.qty);
  if (qty !== undefined && qty > 0) item.qty = qty;
  if (isSourceKind(r.source)) item.source = r.source;
  // Candidate anchors (label/estimate only; grounding ignores them for db).
  const kcal = num(r.kcal);
  const protein_g = num(r.protein_g);
  const fat_g = num(r.fat_g);
  const carb_g = num(r.carb_g);
  if (kcal !== undefined) item.kcal = kcal;
  if (protein_g !== undefined) item.protein_g = protein_g;
  if (fat_g !== undefined) item.fat_g = fat_g;
  if (carb_g !== undefined) item.carb_g = carb_g;
  return item;
}

/**
 * The result of scanning a coach reply: the prose to DISPLAY (block stripped) and
 * the parsed payload (or null when there is no valid block). When a block was
 * present but malformed, `payload` is null and `display` still has it stripped —
 * we never show raw JSON to the user, and we never log a half-parsed meal.
 */
export interface ParsedCoachReply {
  /** The natural-language text to show in the bubble (sentinel block removed). */
  display: string;
  /** The structured meal to log, or null when none/invalid. */
  payload: MealLogPayload | null;
}

/** Match the FIRST sentinel block (non-greedy), capturing its inner text. */
const BLOCK_RE = new RegExp(
  `${escapeRegExp(MEAL_LOG_OPEN)}([\\s\\S]*?)${escapeRegExp(MEAL_LOG_CLOSE)}`,
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the inner JSON of a sentinel block into a MealLogPayload, or null when it
 * doesn't yield at least one usable item. Tolerant of a leading ```json fence the
 * model might wrap inside the sentinel.
 */
function parseBlockBody(body: string): MealLogPayload | null {
  let text = body.trim();
  // Strip an inner code fence if the model added one (```json ... ```).
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
  const rawItems = (parsed as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) return null;
  const items = rawItems.map(toItem).filter((i): i is MealLogItemPayload => i !== null);
  if (items.length === 0) return null;

  const payload: MealLogPayload = { items };
  const rawType = (parsed as { type?: unknown }).type;
  if (typeof rawType === "string" && MEAL_TYPE_SET.has(rawType as MealType)) {
    payload.type = rawType as MealType;
  }
  // Explicit dedupe mode (new/correct). Absent/unknown → "new" (never overwrites).
  payload.mode = parseLogMode((parsed as { mode?: unknown }).mode);
  return payload;
}

/**
 * Scan a raw coach reply for the auto-log block. Returns the display text with
 * the block (and any trailing whitespace it left behind) removed, plus the parsed
 * payload. ALWAYS strips the block from the display — even when it's malformed —
 * so raw JSON can never reach the user. When no block is present, `display` is
 * the input trimmed and `payload` is null.
 */
export function parseCoachReply(raw: string): ParsedCoachReply {
  const match = BLOCK_RE.exec(raw);
  if (!match) {
    return { display: raw.trim(), payload: null };
  }
  const payload = parseBlockBody(match[1]);
  // Remove the whole block; collapse the gap so prose reads naturally.
  const display = raw.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { display, payload };
}

/** True when a reply contains a (possibly malformed) sentinel block. */
export function hasMealLogBlock(raw: string): boolean {
  return BLOCK_RE.test(raw);
}

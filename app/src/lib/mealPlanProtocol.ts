// Structured MEAL_PLAN protocol (chat→食事メニュー提案フロー, AIプランナー 第3陣D).
//
// THE MEAL PLAN CHANNEL — the exact twin of workoutPlanProtocol.ts, but for FUTURE
// food intent. When the coach has read the user's goals + recent meals and the
// user CONFIRMS a proposed 献立 (朝/昼/夕), the coach's reply carries — alongside the
// natural prose — a single fenced sentinel block describing the meals to PLAN (not
// log as eaten). Each planned meal lists its slot (朝/昼/夕/間食), its items (by
// name + grams + qty + source, the SAME shape as MEAL_LOG so grounding is reused),
// an OPTIONAL recipe card (材料 + 手順 the coach wrote), and OPTIONAL start/end
// times for a calendar reflection. The client detects that block, parses +
// validates it, STRIPS it from the displayed text (the user only ever sees natural
// Japanese, never raw JSON), and then:
//   ① bulk-inserts the meals into TODAY's 食事 as `status:"planned"` (so the 食事画面
//      shows them with a 「食べた」 button, but they don't inflate 摂取/PFC/達成 until
//      the user marks each eaten);
//   ② when a meal carries start/end, reflects it onto the calendar via the EXISTING
//      CALENDAR_PLAN path (one 食事 event each) — no new write channel.
//
// ┌─ FABRICATION SAFETY ──────────────────────────────────────────────────────┐
// │ This is a PROPOSAL the user confirmed, not a record of what they ate. The   │
// │ items are grounded by the SAME groundMealLogItems path as the meal log      │
// │ (kcal/PFC from the official DB / sanitised labelled anchors), and they are   │
// │ inserted as `planned`, so 摂取/履歴 stay truthful (a plan ≠ eaten). The model │
// │ writes only names + grams + (recipe prose) + the meal time — never an        │
// │ authoritative kcal/PFC figure. The recipe is presentation-only: it never     │
// │ becomes a logged number. A missing/bad time DROPS the calendar reflection    │
// │ (the plan still inserts); zero usable meals → null payload.                   │
// └────────────────────────────────────────────────────────────────────────────┘
//
// PURE + framework-free (no DOM, no network) so the parse/strip is unit-tested in
// isolation and reused verbatim by the chat client.

import {
  parseLogMode,
  type LogMode,
  type MealLogItemPayload,
} from "./mealLogProtocol";
import { cleanMicros } from "../../functions/_lib/micros";
import type { MealRecipe, MealType, NutritionSourceKind } from "./types";

/** The sentinel that fences the structured meal-PLAN block (distinct from the
 *  MEAL_LOG sentinel so the two flows never collide). Kept in sync with
 *  functions/_llm/chat-prompt.ts MEAL_PLAN_OPEN/CLOSE. */
export const MEAL_PLAN_OPEN = "«MEAL_PLAN»";
export const MEAL_PLAN_CLOSE = "«/MEAL_PLAN»";

/** One meal to PLAN: its slot, its items (same grounding shape as the log path),
 *  an optional recipe card, and an optional calendar time window. */
export interface MealPlanItem {
  /** The meal slot (朝/昼/夕/間食). Defaulted by the applier when absent. */
  type?: MealType;
  /** Items to ground + insert (name/grams/qty/source) — reused from MEAL_LOG. */
  items: MealLogItemPayload[];
  /** Recipe card the coach wrote (材料 + 手順); presentation-only, never a number. */
  recipe?: MealRecipe;
  /** RFC3339-with-zone meal start, when the coach gave one (for the calendar). */
  start?: string;
  /** RFC3339-with-zone meal end, when the coach gave one (end > start). */
  end?: string;
}

/** The full parsed meal-PLAN payload: the meals to plan + the new/correct mode. */
export interface MealPlanPayload {
  meals: MealPlanItem[];
  /** new = add a fresh plan (default); correct = replace the last planned batch. */
  mode?: LogMode;
}

const MEAL_TYPE_SET = new Set<MealType>(["朝", "昼", "夕", "間食"]);

/** A finite, non-negative number or undefined (drops garbage/negatives). */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function isSourceKind(v: unknown): v is NutritionSourceKind {
  return v === "db" || v === "label" || v === "estimate";
}

/** Coerce one raw item into a clean MealLogItemPayload, or null if unusable.
 *  Mirrors mealLogProtocol.toItem EXACTLY so a planned item is identical in shape
 *  to a logged one (it grounds through the same groundMealLogItems path). */
function toItem(raw: unknown): MealLogItemPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;
  const grams = num(r.grams) ?? 0;
  const item: MealLogItemPayload = { name, grams };
  const qty = num(r.qty);
  if (qty !== undefined && qty > 0) item.qty = qty;
  if (isSourceKind(r.source)) item.source = r.source;
  const kcal = num(r.kcal);
  const protein_g = num(r.protein_g);
  const fat_g = num(r.fat_g);
  const carb_g = num(r.carb_g);
  if (kcal !== undefined) item.kcal = kcal;
  if (protein_g !== undefined) item.protein_g = protein_g;
  if (fat_g !== undefined) item.fat_g = fat_g;
  if (carb_g !== undefined) item.carb_g = carb_g;
  const fiber_g = num(r.fiber_g);
  const sugar_g = num(r.sugar_g);
  const sodium_mg = num(r.sodium_mg);
  const saturated_fat_g = num(r.saturated_fat_g);
  if (fiber_g !== undefined) item.fiber_g = fiber_g;
  if (sugar_g !== undefined) item.sugar_g = sugar_g;
  if (sodium_mg !== undefined) item.sodium_mg = sodium_mg;
  if (saturated_fat_g !== undefined) item.saturated_fat_g = saturated_fat_g;
  const gCeil = Math.max(grams, 1);
  const micros = cleanMicros(r.micros, (unit) =>
    unit === "mg" ? gCeil * 1000 : gCeil * 1_000_000,
  );
  if (micros) item.micros = micros;
  return item;
}

/** Max recipe lines kept (bounds the card; a real recipe has few). */
const MAX_RECIPE_LINES = 30;
/** Max chars per recipe line (single-lined). */
const MAX_RECIPE_LINE_CHARS = 200;

/** Single-line + trim + length-clamp a recipe line (untrusted model text). Empty → "". */
function cleanRecipeLine(v: unknown): string {
  if (typeof v !== "string") return "";
  // Strip control chars + line separators (mirrors the sanitizeLine discipline)
  // so a recipe line can't carry an injected heading onto its own line.
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ").trim().slice(0, MAX_RECIPE_LINE_CHARS);
}

/** Coerce a raw string[] into clean, capped recipe lines (drops empties). */
function toRecipeLines(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const lines: string[] = [];
  for (const v of raw) {
    const line = cleanRecipeLine(v);
    if (line) lines.push(line);
    if (lines.length >= MAX_RECIPE_LINES) break;
  }
  return lines.length > 0 ? lines : undefined;
}

/** Coerce a raw recipe object into a clean MealRecipe, or undefined when empty.
 *  Anti-fabrication is the MODEL's job (don't add ingredients it didn't have) —
 *  this layer only sanitises + caps the prose; it never invents a line. */
function toRecipe(raw: unknown): MealRecipe | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const ingredients = toRecipeLines(r.ingredients);
  const steps = toRecipeLines(r.steps);
  // On-hand ingredients (買い物リスト⑤): from the fridge photo the coach saw. Used
  // ONLY to subtract from the shopping list (client-side) — never displayed as a
  // card on its own, so a recipe with only onHand (no ingredients/steps) is empty.
  const onHand = toRecipeLines(r.onHand);
  if (!ingredients && !steps) return undefined;
  return {
    ...(ingredients ? { ingredients } : {}),
    ...(steps ? { steps } : {}),
    ...(onHand ? { onHand } : {}),
  };
}

/** RFC3339 with date + time + an explicit zone (offset or Z) — same as the
 *  calendar-plan validator, so a planned meal time matches the calendar's. */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A valid RFC3339-with-zone datetime that actually parses, else null. */
function validDateTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!RFC3339_RE.test(s)) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

/** Coerce one raw meal into a clean MealPlanItem, or null if it has no usable
 *  item (so an empty/garbage meal is dropped, never planned). */
function toMeal(raw: unknown): MealPlanItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const rawItems = r.items;
  if (!Array.isArray(rawItems)) return null;
  const items = rawItems.map(toItem).filter((i): i is MealLogItemPayload => i !== null);
  if (items.length === 0) return null;

  const meal: MealPlanItem = { items };
  if (typeof r.type === "string" && MEAL_TYPE_SET.has(r.type as MealType)) {
    meal.type = r.type as MealType;
  }
  const recipe = toRecipe(r.recipe);
  if (recipe) meal.recipe = recipe;

  // A meal's calendar time is OPTIONAL: only attach when BOTH are valid zone-aware
  // datetimes AND end > start. A bad/partial/zoneless time drops THIS meal's
  // calendar reflection (it still inserts as a plan) — never an invented time.
  const start = validDateTime(r.start);
  const end = validDateTime(r.end);
  if (start && end && Date.parse(end) > Date.parse(start)) {
    meal.start = start;
    meal.end = end;
  }
  return meal;
}

/**
 * The result of scanning a coach reply for a MEAL_PLAN block: the prose to
 * DISPLAY (block stripped) and the parsed payload (or null when none/invalid).
 * Like the log path, the block is ALWAYS stripped — even when malformed — so raw
 * JSON can never reach the user, and a half-parsed plan is never inserted.
 */
export interface ParsedMealPlanReply {
  display: string;
  payload: MealPlanPayload | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the FIRST meal-plan sentinel block (non-greedy), capturing inner text. */
const BLOCK_RE = new RegExp(
  `${escapeRegExp(MEAL_PLAN_OPEN)}([\\s\\S]*?)${escapeRegExp(MEAL_PLAN_CLOSE)}`,
);

/** Parse the inner JSON of a meal-plan block, tolerant of a ```json fence. */
function parseBlockBody(body: string): MealPlanPayload | null {
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
  const rawMeals = (parsed as { meals?: unknown }).meals;
  if (!Array.isArray(rawMeals)) return null;
  const meals = rawMeals.map(toMeal).filter((m): m is MealPlanItem => m !== null);
  if (meals.length === 0) return null;

  return {
    meals,
    mode: parseLogMode((parsed as { mode?: unknown }).mode),
  };
}

/**
 * Scan a raw coach reply for the MEAL_PLAN block. Returns the display text with
 * the block removed (ALWAYS stripped — even when malformed, so raw JSON never
 * reaches the user) plus the parsed payload (null when none/invalid).
 */
export function parseMealPlanReply(raw: string): ParsedMealPlanReply {
  const match = BLOCK_RE.exec(raw);
  if (!match) return { display: raw.trim(), payload: null };
  const payload = parseBlockBody(match[1]);
  const display = raw.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { display, payload };
}

/** True when a reply contains a (possibly malformed) MEAL_PLAN block. */
export function hasMealPlanBlock(raw: string): boolean {
  return BLOCK_RE.test(raw);
}

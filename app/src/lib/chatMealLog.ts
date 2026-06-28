// Chat→食事 auto-log glue (the marquee feature's client core).
//
// Two pure steps, both unit-testable with no DOM/network:
//   1. analysisToChatContext — turn a grounded MealNutrition (from the EXISTING
//      analyzeMeal pipeline) into the ChatMealAnalysis the coach narrates from.
//      It carries the grounded numbers as PRESENTATION context only.
//   2. buildLoggedMeal — turn a parsed auto-log payload into a Meal whose
//      nutrition is RE-GROUNDED via foodGrounding.groundMealLogItems (DB recompute
//      for db items, sanitised labelled anchors for label/estimate, honest 推定
//      for unknowns). The model's prose numbers NEVER become the logged number.
//
// FABRICATION SAFETY: buildLoggedMeal computes the meal's kcal/PFC from the
// grounded items via itemsToNutrition — exactly like /meal — so a model that
// writes "1200kcal" in the block can never make the logged record say 1200 unless
// the grounded items independently sum to it. The logged meal is fully editable
// in /meal afterwards (it's an ordinary item-backed Meal).

import type { ChatMealAnalysis, ChatMealAnalysisItem } from "./chat";
import type { MealLogItemPayload, MealLogPayload } from "./mealLogProtocol";
import type { Meal, MealNutrition, MealType } from "./types";
import { groundMealLogItems } from "./foodGrounding";
import { itemsToNutrition } from "./mealItems";
import { makeId, toDateKey } from "./date";
import { scaleMicros } from "../../functions/_lib/micros";

/**
 * Map the grounded analysis (the existing MealNutrition with its per-item
 * breakdown) into the ChatMealAnalysis context. Only items that produced a number
 * are forwarded with their numbers; an analysis with NO items → ok:true, items:[]
 * (the coach asks). When analysis failed/threw, callers pass ok:false directly.
 */
export function analysisToChatContext(nutrition: MealNutrition): ChatMealAnalysis {
  const items = (nutrition.items ?? []).map((it) => ({
    name: it.name,
    grams: it.grams * (it.qty || 1),
    kcal: it.kcal,
    proteinG: it.proteinG,
    fatG: it.fatG,
    carbG: it.carbG,
    fiberG: it.fiberG ?? null,
    sugarG: it.sugarG ?? null,
    sodiumMg: it.sodiumMg ?? null,
    saturatedFatG: it.saturatedFatG ?? null,
    micros: it.micros,
    sourceLabel: it.source ?? null,
    sourceKind: it.sourceKind,
  }));
  return { ok: true, items, estimated: nutrition.estimated === true };
}

/** A photo that couldn't be analysed as food → tell the coach to handle it. */
export const NON_FOOD_ANALYSIS: ChatMealAnalysis = { ok: false };

/** Loosely normalise a name for analysis↔block matching (trim, lower, drop spaces). */
function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}

const SCOOP_FOOD_RE = /(プロテイン|ホエイ|whey|protein|粉末|パウダー)/i;
const SCOOP_UNIT_RE = "(?:杯|スクープ|スプーン|scoop)";

function normalizeQuantityText(text: string): string {
  return text
    .replace(/[０-９．]/g, (ch) =>
      ch === "．" ? "." : String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/一/g, "1")
    .replace(/二/g, "2")
    .replace(/三/g, "3");
}

function toPositiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function roundOne(n: number): number {
  return Math.round(n * 10) / 10;
}

function finiteNumber(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function scaleAnchor(v: number | undefined, ratio: number | null): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return v;
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return undefined;
  return roundOne(v * ratio);
}

function scaleAnchorMicros(
  micros: MealLogItemPayload["micros"] | ChatMealAnalysisItem["micros"],
  ratio: number | null,
): MealLogItemPayload["micros"] | undefined {
  if (!micros || ratio === null || !Number.isFinite(ratio) || ratio <= 0) return undefined;
  return scaleMicros(micros, ratio);
}

function scoopPortionFromText(text: string): { gramsPerUnit: number; qty: number } | null {
  const s = normalizeQuantityText(text);
  const perUnitPatterns = [
    new RegExp(`(?:1\\s*)?${SCOOP_UNIT_RE}\\s*(?:あたり|当たり|=|＝|は|が|で)?\\s*(\\d+(?:\\.\\d+)?)\\s*g`, "i"),
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*g\\s*(?:/|／|毎|あたり|当たり)?\\s*(?:1\\s*)?${SCOOP_UNIT_RE}`, "i"),
  ];
  const gramsPerUnit = perUnitPatterns
    .map((re) => toPositiveNumber(re.exec(s)?.[1]))
    .find((n): n is number => n !== null);
  if (!gramsPerUnit) return null;

  const countRe = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${SCOOP_UNIT_RE}(?!\\s*(?:あたり|当たり))`, "gi");
  let m: RegExpExecArray | null;
  while ((m = countRe.exec(s)) !== null) {
    const qty = toPositiveNumber(m[1]);
    if (qty !== null) return { gramsPerUnit, qty };
    if (m.index === countRe.lastIndex) countRe.lastIndex++;
  }
  return { gramsPerUnit, qty: 1 };
}

/**
 * Correct obvious scoop arithmetic that the LLM sometimes mis-converts in the
 * MEAL_LOG block. Example: user says "1杯あたり10g、1.5杯" but the block says
 * grams:120. The user's arithmetic wins; anchors are scaled to the corrected
 * per-unit grams and remain labelled/estimated downstream.
 */
export function applyUserStatedMealPortions(
  payload: MealLogPayload,
  userText?: string,
): MealLogPayload {
  if (!userText) return payload;
  const scoop = scoopPortionFromText(userText);
  if (!scoop) return payload;

  let changed = false;
  const items = payload.items.map((item) => {
    if (!SCOOP_FOOD_RE.test(item.name)) return item;
    const oldUnitGrams = typeof item.grams === "number" && item.grams > 0 ? item.grams : null;
    const ratio = oldUnitGrams ? scoop.gramsPerUnit / oldUnitGrams : null;
    const micros = scaleAnchorMicros(item.micros, ratio);
    changed = true;
    return {
      ...item,
      source: (item.source === "label" ? "label" : "estimate") as MealLogItemPayload["source"],
      grams: scoop.gramsPerUnit,
      qty: scoop.qty,
      portion_basis: "stated" as const,
      kcal: scaleAnchor(item.kcal, ratio),
      protein_g: scaleAnchor(item.protein_g, ratio),
      fat_g: scaleAnchor(item.fat_g, ratio),
      carb_g: scaleAnchor(item.carb_g, ratio),
      fiber_g: scaleAnchor(item.fiber_g, ratio),
      sugar_g: scaleAnchor(item.sugar_g, ratio),
      sodium_mg: scaleAnchor(item.sodium_mg, ratio),
      saturated_fat_g: scaleAnchor(item.saturated_fat_g, ratio),
      ...(micros ? { micros } : {}),
    };
  });

  return changed ? { ...payload, items } : payload;
}

function analysisSource(sourceKind: ChatMealAnalysisItem["sourceKind"]): "label" | "estimate" | null {
  if (sourceKind === "label") return "label";
  if (sourceKind === "estimate") return "estimate";
  return null;
}

function withStatedPortionAnalysisAnchor(
  item: MealLogItemPayload,
  match: ChatMealAnalysisItem,
): MealLogItemPayload {
  const source = item.source === "label" ? "label" : analysisSource(match.sourceKind);
  if (!source) return item;
  const ratio =
    typeof match.grams === "number" && Number.isFinite(match.grams) && match.grams > 0
      ? item.grams / match.grams
      : null;
  const next: MealLogItemPayload = {
    ...item,
    source,
    portion_basis: "stated",
  };

  const kcal = scaleAnchor(finiteNumber(match.kcal), ratio);
  if (kcal !== undefined) next.kcal = kcal;
  const protein = scaleAnchor(finiteNumber(match.proteinG), ratio);
  if (protein !== undefined) next.protein_g = protein;
  const fat = scaleAnchor(finiteNumber(match.fatG), ratio);
  if (fat !== undefined) next.fat_g = fat;
  const carb = scaleAnchor(finiteNumber(match.carbG), ratio);
  if (carb !== undefined) next.carb_g = carb;
  const fiber = scaleAnchor(finiteNumber(match.fiberG), ratio);
  if (fiber !== undefined) next.fiber_g = fiber;
  const sugar = scaleAnchor(finiteNumber(match.sugarG), ratio);
  if (sugar !== undefined) next.sugar_g = sugar;
  const sodium = scaleAnchor(finiteNumber(match.sodiumMg), ratio);
  if (sodium !== undefined) next.sodium_mg = sodium;
  const saturatedFat = scaleAnchor(finiteNumber(match.saturatedFatG), ratio);
  if (saturatedFat !== undefined) next.saturated_fat_g = saturatedFat;
  const micros = scaleAnchorMicros(match.micros, ratio);
  if (micros !== undefined) next.micros = micros;

  return next;
}

/**
 * CHANGE 3 — tighten label/estimate numbers to the ANALYSIS, not the chat LLM.
 *
 * For label/estimate items, the number the chat model re-typed into the block can
 * drift from what the grounded analysis (analyzeMeal) actually produced. When an
 * analysis is available and carries a matching item (by name) WITH a number, we
 * override the block's candidate anchor with the analysis's grounded figure +
 * grams, so the LOGGED estimate equals what the analysis produced. db items are
 * left untouched (they recompute from the official DB regardless of the anchor),
 * and a label/estimate with no analysis match keeps the block's anchor (still
 * sanitised + bounded + labelled downstream). Never fabricates: it only ever
 * copies a number the analysis already grounded.
 */
function reconcileWithAnalysis(
  items: MealLogItemPayload[],
  analysis?: ChatMealAnalysis,
): MealLogItemPayload[] {
  if (!analysis || analysis.ok === false || !analysis.items || analysis.items.length === 0) {
    return items;
  }
  // Index the analysis items by normalised name (first match wins).
  const byName = new Map<string, ChatMealAnalysisItem>();
  for (const it of analysis.items) {
    const key = normName(it.name);
    if (key && !byName.has(key)) byName.set(key, it);
  }
  return items.map((item) => {
    const match = byName.get(normName(item.name));
    // Only override when the analysis grounded an actual kcal for this item.
    if (!match || typeof match.kcal !== "number") return item;

    // User-stated portions are the top authority for grams/qty. Analysis may still
    // provide the label/estimate nutrient anchor, scaled to the stated per-unit
    // grams, especially when the LLM wrongly tagged a supplement as source:"db".
    if (item.portion_basis === "stated") {
      return withStatedPortionAnalysisAnchor(item, match);
    }

    const source = item.source ?? "db";
    // A db analysis match stays DB-authoritative and recomputes from the official DB.
    // But if the chat block wrongly tagged an unmatched supplement/product as db
    // while the photo/text analysis grounded it as label/estimate (e.g. プロテイン),
    // carry that sourced estimate through instead of logging a no-number 0 kcal row.
    if (source === "db" && match.sourceKind === "db") return item;

    const itemWithoutAnchors: MealLogItemPayload = {
      name: item.name,
      grams: item.grams,
      ...(item.qty !== undefined ? { qty: item.qty } : {}),
      ...(item.source ? { source: item.source } : {}),
      ...(item.portion_basis ? { portion_basis: item.portion_basis } : {}),
    };

    if (match.sourceKind === "db") {
      return {
        ...itemWithoutAnchors,
        source: "db",
        // Preserve the grounded analysis portion; do not let a stale
        // portion_basis:"standard" re-default it later.
        portion_basis: "estimated",
        grams: match.grams,
        qty: 1,
      };
    }

    return {
      ...itemWithoutAnchors,
      source: source === "db" ? (match.sourceKind === "label" ? "label" : "estimate") : source,
      // Preserve the grounded analysis portion; do not let a stale
      // portion_basis:"standard" re-default it later.
      portion_basis: "estimated",
      // Use the analysis's grounded portion + numbers as the candidate anchor, so
      // the logged label/estimate equals the analysis (not the chat model's retype).
      grams: match.grams,
      qty: 1,
      kcal: match.kcal,
      ...(typeof match.proteinG === "number" ? { protein_g: match.proteinG } : {}),
      ...(typeof match.fatG === "number" ? { fat_g: match.fatG } : {}),
      ...(typeof match.carbG === "number" ? { carb_g: match.carbG } : {}),
      // Extra nutrients too — only when the analysis grounded a number for them.
      ...(typeof match.fiberG === "number" ? { fiber_g: match.fiberG } : {}),
      ...(typeof match.sugarG === "number" ? { sugar_g: match.sugarG } : {}),
      ...(typeof match.sodiumMg === "number" ? { sodium_mg: match.sodiumMg } : {}),
      ...(typeof match.saturatedFatG === "number" ? { saturated_fat_g: match.saturatedFatG } : {}),
      // Vitamins/minerals (拡張①): copy the analysis's grounded micros when present.
      ...(match.micros ? { micros: match.micros } : {}),
    };
  });
}

/**
 * Build a Meal from a parsed auto-log payload — the no-fabrication write step.
 * The nutrition is derived from RE-GROUNDED items (groundMealLogItems), so the
 * logged numbers come from the grounded pipeline, not the model's text. Returns
 * null when nothing groundable remains (so we never log an empty/garbage meal).
 *
 * `date` defaults to today; `photoId` (the chat photo) is attached so the meal
 * keeps its picture in /meal. The meal type comes from the payload, else 昼.
 * `id` lets a caller KEEP a meal's id stable across a re-ground (update-in-place
 * within a photo rally — see applyMealLog); omitted → a fresh id (a new meal).
 */
export function buildLoggedMeal(
  payload: MealLogPayload,
  opts: {
    id?: string;
    date?: string;
    photoId?: string;
    now?: Date;
    /** The grounded photo analysis (CHANGE 3): tighten label/estimate numbers to it. */
    analysis?: ChatMealAnalysis;
  } = {},
): Meal | null {
  // CHANGE 3: reconcile label/estimate anchors with the grounded analysis before
  // grounding, so the logged estimate equals what the analysis produced (db items
  // are untouched — they recompute from the official DB).
  const reconciled = reconcileWithAnalysis(payload.items, opts.analysis);
  const items = groundMealLogItems(reconciled);
  if (items.length === 0) return null;

  const nutrition: MealNutrition = itemsToNutrition(items);
  // itemsToNutrition always returns an object; if literally nothing produced a
  // number the meal still logs (honest 推定 rows the user can fix), but guard
  // against a totally empty item list above.

  const date = opts.date ?? toDateKey();
  const now = opts.now ?? new Date();
  const type: MealType = payload.type ?? "昼";
  return {
    id: opts.id ?? makeId(),
    date,
    timestamp: date === toDateKey() ? now.toISOString() : `${date}T12:00:00.000Z`,
    type,
    text: items.map((i) => i.name).join("、"),
    photoId: opts.photoId,
    nutrition,
  };
}

/**
 * The result of applying one MEAL_LOG payload against the current meal store.
 * `meals` is the next store array to persist; `mealId` is the logged/updated
 * meal id (recorded on the assistant chat message so a later "correct" turn can
 * resolve it from persisted history). `itemCount` backs the "食事に記録しました" chip.
 */
export interface ApplyMealLogResult {
  meals: Meal[];
  mealId: string;
  itemCount: number;
  action: "appended" | "updated";
}

/**
 * Apply ONE MEAL_LOG payload to the store with EXPLICIT, PERSISTENT de-dupe —
 * the redesigned chat→食事 guard (replaces the old in-memory "rally" heuristic).
 *
 * The dedupe signal is now carried in the block (`payload.mode`) and resolved
 * against the PERSISTED chat history, not an in-memory ref:
 *
 *   - mode "new" (default): APPEND a distinct grounded meal. A genuinely new
 *     meal — even text-only, even right after a photo — is always a new entry, so
 *     "also log the banana" can never overwrite the prior meal (over-merge fixed).
 *   - mode "correct": UPDATE the most-recent logged meal IN PLACE. `correctId` is
 *     that meal's id, which the caller resolves from the persisted chat history
 *     (the assistant message that carried `loggedMeal`). Because history is
 *     persisted, this survives a page reload / remount (under-merge fixed); after
 *     clear() there is no history → correctId is null → it logs nothing and the
 *     caller can make the reply honest instead of pretending a correction landed.
 *     The entry keeps its id + original timestamp (no calendar drift).
 *
 * A "correct" whose `correctId` is null (no prior log in history) or points at a
 * meal no longer in the store (deleted in /meal) returns null — no ghost update,
 * no duplicate append, no false "直しました". Idempotent: a repeated "correct"
 * re-grounds the same entry rather than duplicating it.
 *
 * FABRICATION SAFETY is unchanged: the meal is built by `buildLoggedMeal`, whose
 * nutrition comes ONLY from the grounded pipeline — never from the model's prose.
 *
 * Returns null when the payload grounds to nothing (so the caller logs nothing).
 */
export function applyMealLog(
  payload: MealLogPayload,
  opts: {
    meals: Meal[];
    /** Id of the most-recent logged meal from persisted history (for mode "correct"). */
    correctId?: string | null;
    date?: string;
    photoId?: string;
    now?: Date;
    /** Grounded photo analysis to tighten label/estimate numbers (CHANGE 3). */
    analysis?: ChatMealAnalysis;
    /** User's latest natural-language turn, used only for deterministic stated portions. */
    userText?: string;
  },
): ApplyMealLogResult | null {
  const payloadToApply = applyUserStatedMealPortions(payload, opts.userText);
  const mode = payloadToApply.mode ?? "new";
  // Only a "correct" with a resolvable target updates in place; everything else
  // (new, or correct with no/stale target) appends. This is the over-merge fix:
  // a new meal can NEVER land on the update path.
  const existing =
    mode === "correct" && opts.correctId != null
      ? opts.meals.find((m) => m.id === opts.correctId)
      : undefined;

  if (mode === "correct" && !existing) {
    return null;
  }

  if (existing) {
    // UPDATE in place: re-ground from the new payload, keep the SAME id, and
    // anchor the entry to its original date/timestamp (so a correction doesn't
    // move it on the calendar). photoId falls back to the existing one when this
    // (text-only) turn carried no new photo.
    const reground = buildLoggedMeal(payloadToApply, {
      id: existing.id,
      date: existing.date,
      photoId: opts.photoId ?? existing.photoId,
      now: opts.now,
      analysis: opts.analysis,
    });
    if (!reground) return null; // new payload grounds to nothing → keep old entry
    const updated: Meal = { ...reground, timestamp: existing.timestamp };
    const meals = opts.meals.map((m) => (m.id === existing.id ? updated : m));
    return {
      meals,
      mealId: updated.id,
      itemCount: updated.nutrition?.items?.length ?? 0,
      action: "updated",
    };
  }

  // APPEND: a new meal.
  const meal = buildLoggedMeal(payloadToApply, {
    date: opts.date,
    photoId: opts.photoId,
    now: opts.now,
    analysis: opts.analysis,
  });
  if (!meal) return null;
  return {
    meals: [...opts.meals, meal],
    mealId: meal.id,
    itemCount: meal.nutrition?.items?.length ?? 0,
    action: "appended",
  };
}

/**
 * Resolve the id of the most-recent meal logged in the PERSISTED chat history —
 * the target a "correct" block updates. Scans the messages newest-first for an
 * assistant turn carrying `loggedMeal` and returns its mealId, or null when none
 * (a fresh chat, or after clear()). Pure: the caller passes the stored messages
 * (loaded from localStorage), so this is reload-safe by construction.
 */
export function lastLoggedMealId(
  messages: ReadonlyArray<{ role: string; loggedMeal?: { mealId: string } | undefined }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.loggedMeal?.mealId) return m.loggedMeal.mealId;
  }
  return null;
}

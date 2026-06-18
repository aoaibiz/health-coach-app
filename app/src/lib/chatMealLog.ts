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
    // db items are DB-authoritative; their anchor numbers are ignored downstream.
    if ((item.source ?? "db") === "db") return item;
    const match = byName.get(normName(item.name));
    // Only override when the analysis grounded an actual kcal for this item.
    if (!match || typeof match.kcal !== "number") return item;
    return {
      ...item,
      // Use the analysis's grounded portion + numbers as the candidate anchor, so
      // the logged label/estimate equals the analysis (not the chat model's retype).
      grams: match.grams,
      qty: 1,
      kcal: match.kcal,
      ...(typeof match.proteinG === "number" ? { protein_g: match.proteinG } : {}),
      ...(typeof match.fatG === "number" ? { fat_g: match.fatG } : {}),
      ...(typeof match.carbG === "number" ? { carb_g: match.carbG } : {}),
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
 *     clear() there is no history → correctId is null → it safely APPENDS.
 *     The entry keeps its id + original timestamp (no calendar drift).
 *
 * A "correct" whose `correctId` is null (no prior log in history) or points at a
 * meal no longer in the store (deleted in /meal) safely falls back to APPEND — no
 * ghost update, no silent no-op. Idempotent: a repeated "correct" re-grounds the
 * same entry rather than duplicating it.
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
  },
): ApplyMealLogResult | null {
  const mode = payload.mode ?? "new";
  // Only a "correct" with a resolvable target updates in place; everything else
  // (new, or correct with no/stale target) appends. This is the over-merge fix:
  // a new meal can NEVER land on the update path.
  const existing =
    mode === "correct" && opts.correctId != null
      ? opts.meals.find((m) => m.id === opts.correctId)
      : undefined;

  if (existing) {
    // UPDATE in place: re-ground from the new payload, keep the SAME id, and
    // anchor the entry to its original date/timestamp (so a correction doesn't
    // move it on the calendar). photoId falls back to the existing one when this
    // (text-only) turn carried no new photo.
    const reground = buildLoggedMeal(payload, {
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
    };
  }

  // APPEND: a new meal (or a correction with no resolvable target → safe append).
  const meal = buildLoggedMeal(payload, {
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

// "昨日と同じ量" reuse — the deterministic chat→食事 shortcut.
//
// THE PROBLEM IT FIXES: when the user tells the coach "昨日と同じ量" (log the same
// as yesterday), the LLM coach only ever sees TODAY's logged data in its context —
// it has no access to yesterday's records, so it re-asks for grams and the meal is
// never recorded ("まるで入っていない"). This module resolves "same as yesterday"
// CLIENT-SIDE, before the LLM round-trip: it finds yesterday's actually-logged
// meal for the relevant slot and RE-LOGS it verbatim for today (items + grams +
// kcal/PFC copied exactly), so nothing is re-asked and nothing is fabricated — the
// numbers are literally yesterday's own grounded record.
//
// PURE + framework-free (no DOM, no storage, no network): the caller passes in the
// candidate meals (read via the existing storage API) and the current time, so this
// is fully unit-testable. The only "default for 同じ is reuse, not re-ask" policy
// lives here.

import type { Meal, MealItem, MealNutrition, MealType } from "./types";
import { makeId, toDateKey, shiftDateKey } from "./date";

/**
 * Whether a user message is a "log the same as yesterday" request. Matches the
 * common Japanese phrasings — 昨日と同じ / きのうと同じ / 昨日と一緒 / 昨日のと同じ —
 * including the "…量" and "…ので登録して" variants. Deliberately requires BOTH a
 * yesterday word AND a sameness word so a sentence merely MENTIONING 昨日 (e.g.
 * "昨日は食べすぎた") never triggers a silent re-log.
 */
export function isSameAsYesterday(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // A yesterday reference: 昨日 / きのう / キノウ / 前日.
  const hasYesterday = /昨日|きのう|キノウ|前日/.test(t);
  if (!hasYesterday) return false;
  // A sameness reference: 同じ / おなじ / 一緒 / いっしょ / 同様.
  const hasSame = /同じ|おなじ|一緒|いっしょ|同様/.test(t);
  return hasSame;
}

/** Meal-slot keywords → MealType, longest/most-specific handled by order. */
const SLOT_KEYWORDS: Array<{ re: RegExp; type: MealType }> = [
  { re: /朝食|朝ごはん|朝ご飯|朝飯|あさごはん|朝メシ|朝/, type: "朝" },
  { re: /昼食|昼ごはん|昼ご飯|昼飯|ひるごはん|ランチ|お昼|昼メシ|昼/, type: "昼" },
  { re: /夕食|夕飯|夜ごはん|夜ご飯|晩ごはん|晩ご飯|晩飯|ディナー|夕ご飯|夕飯|夜|夕|晩/, type: "夕" },
  { re: /間食|おやつ|軽食|スナック/, type: "間食" },
];

/**
 * The meal slot the user explicitly named in the message (朝/昼/夕/間食), or null
 * when they didn't name one. Used to pick WHICH of yesterday's meals to copy.
 */
export function explicitSlot(text: string): MealType | null {
  for (const { re, type } of SLOT_KEYWORDS) {
    if (re.test(text)) return type;
  }
  return null;
}

/**
 * Infer the most likely meal slot from the local hour when the user didn't name
 * one — the same rough time bands the coach uses for time-awareness:
 *   05–10 → 朝, 11–15 → 昼, 16–22 → 夕, otherwise (late night/early am) → 間食.
 * This is only a DEFAULT for slot selection; the user can always name the slot.
 */
export function inferSlotFromHour(hour: number): MealType {
  if (hour >= 5 && hour <= 10) return "朝";
  if (hour >= 11 && hour <= 15) return "昼";
  if (hour >= 16 && hour <= 22) return "夕";
  return "間食";
}

/** Copy one logged MealItem, giving it a fresh id (numbers/portion unchanged). */
function copyItem(item: MealItem): MealItem {
  return { ...item, id: makeId() };
}

/** Deep-copy a meal's nutrition for re-logging: same numbers, fresh item ids. */
function copyNutrition(nutrition: MealNutrition): MealNutrition {
  return {
    ...nutrition,
    items: nutrition.items ? nutrition.items.map(copyItem) : undefined,
  };
}

/**
 * Pick yesterday's meal to reuse for a "same as yesterday" request:
 *   - filter to yesterday's date AND the target slot;
 *   - among those, prefer the one with a per-item nutrition breakdown (so the
 *     re-log carries the editable items + their grounded numbers), else any meal
 *     that has nutrition, else the most recent of the slot.
 * Returns null when yesterday has no usable meal for that slot (→ caller falls
 * back to asking — the ONLY case where we don't reuse). Pure.
 */
export function findYesterdayMeal(
  meals: Meal[],
  yesterdayKey: string,
  slot: MealType,
): Meal | null {
  // Only EATEN meals are "what the user actually ate yesterday" — a not-yet-eaten
  // PLAN (status "planned", AIプランナー 第3陣D) must not be copied as a real past
  // meal. ABSENT status → eaten (unchanged for every pre-feature/logged meal).
  const sameSlot = meals.filter(
    (m) => m.date === yesterdayKey && m.type === slot && m.status !== "planned",
  );
  if (sameSlot.length === 0) return null;
  // Newest first, so "the meal" for a slot is the latest logged that day.
  const byNewest = [...sameSlot].sort((a, b) =>
    (b.timestamp ?? "").localeCompare(a.timestamp ?? ""),
  );
  // Prefer a meal that actually carries nutrition (a real number to reuse); among
  // those prefer one with an item breakdown. An empty (no-nutrition) record is a
  // last resort so we never silently log a blank meal as "the same".
  const withItems = byNewest.find(
    (m) => (m.nutrition?.items?.length ?? 0) > 0,
  );
  if (withItems) return withItems;
  const withNutrition = byNewest.find((m) => {
    const n = m.nutrition;
    return (
      n != null &&
      (n.calories != null || n.proteinG != null || n.fatG != null || n.carbG != null)
    );
  });
  return withNutrition ?? byNewest[0];
}

/** The outcome of resolving a "same as yesterday" request. */
export interface SameAsYesterdayResult {
  /** A new Meal for TODAY copied from yesterday's record (fresh ids/timestamp). */
  meal: Meal;
  /** The slot that was reused (for the confirmation message). */
  slot: MealType;
  /** The yesterday meal we copied (so the caller can describe it). */
  source: Meal;
}

/**
 * Resolve a "same as yesterday" request into a ready-to-log Meal for TODAY, or
 * null when there's nothing to reuse (yesterday has no logged meal for the slot →
 * the caller should ask). DEFAULT for "同じ" is REUSE: only a genuine absence of
 * yesterday's record returns null.
 *
 * The returned meal copies yesterday's items + grams + kcal/PFC EXACTLY (no
 * re-grounding, no fabrication — it's literally yesterday's own grounded numbers),
 * but gets a fresh id, today's date, and a now-timestamp so it lands on today.
 *
 * `now` + `meals` are injected so this is pure/testable; the caller passes the
 * meals it read from storage and the device clock.
 */
export function resolveSameAsYesterday(
  text: string,
  meals: Meal[],
  now: Date = new Date(),
): SameAsYesterdayResult | null {
  if (!isSameAsYesterday(text)) return null;
  const todayKey = toDateKey(now);
  const yesterdayKey = shiftDateKey(todayKey, -1);
  const slot = explicitSlot(text) ?? inferSlotFromHour(now.getHours());
  const source = findYesterdayMeal(meals, yesterdayKey, slot);
  if (!source || !source.nutrition) return null;

  const meal: Meal = {
    id: makeId(),
    date: todayKey,
    timestamp: now.toISOString(),
    type: slot,
    text: source.text,
    // The photo belonged to yesterday's record; the re-log is a text-driven copy,
    // so it carries no photo (the user can attach one if they want).
    nutrition: copyNutrition(source.nutrition),
  };
  return { meal, slot, source };
}

/** Slot → natural Japanese label for the confirmation message. */
const SLOT_LABEL: Record<MealType, string> = {
  朝: "朝食",
  昼: "昼食",
  夕: "夕食",
  間食: "間食",
};

/**
 * A short, honest confirmation the coach bubble shows after a "same as yesterday"
 * re-log. States exactly what was copied (slot + item names + the reused calorie
 * total) so the user can see the meal really landed — and that the numbers are
 * yesterday's own, not invented. Pure (no formatting library).
 */
export function sameAsYesterdayConfirmation(result: SameAsYesterdayResult): string {
  const label = SLOT_LABEL[result.slot];
  const items = result.meal.nutrition?.items ?? [];
  const names = items.map((i) => i.name).filter((n) => n && n.trim());
  const kcal = result.meal.nutrition?.calories;
  const list = names.length > 0 ? names.join("、") : result.meal.text;
  const kcalPart =
    typeof kcal === "number" ? `（約${Math.round(kcal)}kcal）` : "";
  return `昨日の${label}と同じ内容で記録しておきました：${list}${kcalPart}。違っていたら教えてくださいね。`;
}

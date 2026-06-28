import type { Meal, MealItem } from "./types";
import { effectiveGrams, itemsToNutrition, setItemGrams, setItemQty } from "./mealItems";
import { isScoopFoodName, parseScoopPortionFromText } from "./chatMealLog";
import { toDateKey } from "./date";

export interface DirectMealCorrectionResult {
  meals: Meal[];
  mealId: string;
  itemCount: number;
  note: string;
}

const CORRECTION_INTENT_RE =
  /(修正|訂正|変更|直し|直して|違う|違って|間違|誤り|おかしい|じゃなく|ではなく|でなく|じゃない|ではない)/;

function normalizeText(text: string): string {
  return text
    .replace(/[０-９．]/g, (ch) =>
      ch === "．" ? "." : String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/一/g, "1")
    .replace(/二/g, "2")
    .replace(/三/g, "3")
    .toLowerCase();
}

function normName(name: string): string {
  return normalizeText(name).replace(/\s+/g, "");
}

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseCorrectedTotalGrams(text: string): number | null {
  const s = normalizeText(text);
  const preferred = [
    /(?:じゃなく|ではなく|でなく|じゃない|ではない|→|⇒|=>)\s*(\d+(?:\.\d+)?)\s*g/i,
    /(\d+(?:\.\d+)?)\s*g\s*(?:に|へ|で).{0,12}(?:直|修正|訂正|変更)/i,
    /(?:合計|全部|総量|量|グラム|g)\D{0,12}(\d+(?:\.\d+)?)\s*g/i,
  ];
  for (const re of preferred) {
    const n = toNumber(re.exec(s)?.[1]);
    if (n !== null) return n;
  }
  const all = [...s.matchAll(/(\d+(?:\.\d+)?)\s*g/gi)]
    .map((m) => toNumber(m[1]))
    .filter((n): n is number => n !== null);
  return all.length === 1 ? all[0] : null;
}

function chooseMeal(
  meals: Meal[],
  correctId: string | null | undefined,
  userText: string,
  wantsScoopCorrection: boolean,
): Meal | null {
  if (correctId) {
    const byId = meals.find((m) => m.id === correctId);
    if (byId) return byId;
  }

  const today = toDateKey();
  const text = normName(userText);
  const candidates = meals
    .filter((m) => m.nutrition?.items?.length)
    .filter((m) => {
      const items = m.nutrition?.items ?? [];
      return items.some((item) => {
        if (wantsScoopCorrection && isScoopFoodName(item.name)) return true;
        const name = normName(item.name);
        return name.length >= 2 && text.includes(name);
      });
    })
    .sort((a, b) => (b.timestamp ?? b.date).localeCompare(a.timestamp ?? a.date));

  if (candidates.length === 1) return candidates[0];
  const todayCandidates = candidates.filter((m) => m.date === today);
  return todayCandidates.length === 1 ? todayCandidates[0] : null;
}

function chooseItem(
  meal: Meal,
  userText: string,
  wantsScoopCorrection: boolean,
): MealItem | null {
  const items = meal.nutrition?.items ?? [];
  const text = normName(userText);
  const mentionsScoopFood = /(プロテイン|ホエイ|whey|protein|粉末|パウダー)/i.test(userText);
  const allowsImplicitSingleItem = /(それ|これ|さっき|今の|この(食事|記録)|直前)/.test(userText);
  const candidates = items.filter((item) => {
    if (wantsScoopCorrection && isScoopFoodName(item.name)) return true;
    if (mentionsScoopFood && isScoopFoodName(item.name)) return true;
    const name = normName(item.name);
    return name.length >= 2 && text.includes(name);
  });
  if (candidates.length === 1) return candidates[0];
  if (
    candidates.length === 0 &&
    items.length === 1 &&
    allowsImplicitSingleItem &&
    !mentionsScoopFood
  ) {
    return items[0];
  }
  return null;
}

function replaceMealItem(meal: Meal, target: MealItem, nextItem: MealItem): Meal {
  const currentItems = meal.nutrition?.items ?? [];
  const nextItems = currentItems.map((item) => (item.id === target.id ? nextItem : item));
  return {
    ...meal,
    text: nextItems.map((item) => item.name).join("、"),
    nutrition: itemsToNutrition(nextItems, {
      source: meal.nutrition?.source,
      generatedBy: meal.nutrition?.generatedBy,
    }),
  };
}

function formatAmount(item: MealItem): string {
  const grams = Number.isInteger(item.grams) ? `${item.grams}` : `${item.grams}`;
  const qty = item.qty && item.qty !== 1 ? `×${item.qty}` : "";
  return `${grams}g${qty}`;
}

/**
 * Deterministic safety net for clear meal corrections. The LLM should emit a
 * MEAL_LOG mode:"correct" block, but when the user's Japanese is already
 * unambiguous (e.g. "プロテインは120gじゃなく、1杯10gを1.5杯"), the app can and
 * should update the saved meal itself instead of only appending an apology.
 */
export function applyDirectMealCorrectionFromText(
  userText: string,
  opts: { meals: Meal[]; correctId?: string | null },
): DirectMealCorrectionResult | null {
  const text = userText.trim();
  if (!text) return null;

  const scoop = parseScoopPortionFromText(text);
  const hasIntent = CORRECTION_INTENT_RE.test(text);
  const totalGrams = scoop ? null : parseCorrectedTotalGrams(text);
  if (!hasIntent) return null;
  if (!scoop && totalGrams === null) return null;

  const meal = chooseMeal(opts.meals, opts.correctId, text, scoop !== null);
  if (!meal) return null;
  const target = chooseItem(meal, text, scoop !== null);
  if (!target) return null;

  const corrected = scoop
    ? setItemQty(setItemGrams(target, scoop.gramsPerUnit), scoop.qty)
    : setItemQty(setItemGrams(target, totalGrams ?? effectiveGrams(target)), 1);
  const nextMeal = replaceMealItem(meal, target, corrected);
  const meals = opts.meals.map((m) => (m.id === meal.id ? nextMeal : m));

  return {
    meals,
    mealId: meal.id,
    itemCount: nextMeal.nutrition?.items?.length ?? 0,
    note: `保存データも修正しました: ${target.name} ${formatAmount(corrected)}`,
  };
}

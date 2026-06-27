// 買い物リスト (AIプランナー 第3陣D — 買い物リスト⑤). Pure + framework-free.
//
// THE DIFF, computed CLIENT-SIDE (never by the model) so it can't be fabricated:
// a recipe lists the材料 it needs; the fridge photo (Phase2) identified what's
// ON HAND. The shopping list is the材料 the recipe needs that are NOT on hand —
// "あるものは買い物リストに入れない・推測で増やさない" (the spec's floor). When no
// fridge context exists, there's nothing to subtract, so we honestly return the
// WHOLE ingredient list (the user buys/has everything) rather than guessing.
//
// Matching is loose (normalised substring either-direction) so "鶏むね肉 100g" on
// the recipe matches "鶏むね肉" on hand, and "卵2個" matches "卵". It never adds an
// ingredient the recipe didn't list — it only ever REMOVES on-hand ones.

/** Normalise an ingredient string for loose matching: drop quantity/space/symbols,
 *  lowercase. e.g. "鶏むね肉 100g" / "卵2個" → "鶏むね肉" / "卵". Pure. */
export function normalizeIngredient(s: string): string {
  if (typeof s !== "string") return "";
  return s
    .trim()
    .toLowerCase()
    // Strip a quantity in EITHER order so the food NAME is what we compare, not the
    // portion: "鶏むね肉100g"/"卵2個" (number→unit) AND "大さじ1"/"少々" (unit→number).
    .replace(/(?:大さじ|小さじ|カップ)\s*[0-9０-９]+(?:\/[0-9０-９]+)?/g, "")
    .replace(/[0-9０-９]+\s*(?:g|kg|mg|ml|l|cc|個|本|枚|玉|杯|片|束|袋|缶|パック|切れ|尾|房|株|大さじ|小さじ|カップ)?/g, "")
    .replace(/少々|適量|お好みで/g, "")
    .replace(/[\s　・,、()（）]/g, "")
    .trim();
}

/** True when an on-hand item covers a needed ingredient (loose, either-direction
 *  substring on the normalised names). Empty normalised name never matches. */
function onHandCovers(needNorm: string, haveNorm: string): boolean {
  if (!needNorm || !haveNorm) return false;
  return needNorm.includes(haveNorm) || haveNorm.includes(needNorm);
}

/**
 * Compute the 買い物リスト for a recipe: the ingredient lines the recipe needs that
 * are NOT covered by anything on hand. Preserves the recipe's original strings
 * (with their portions) + order, de-duplicates by normalised name, and drops blank
 * lines. With no `onHand` (no fridge context) it returns the whole de-duped list —
 * we never guess that something is already in the fridge. Pure + testable.
 *
 *   ingredients: the recipe's材料 lines (e.g. ["鶏むね肉 100g","卵 2個","醤油"]).
 *   onHand:      the fridge photo's identified ingredients (e.g. ["卵","醤油"]).
 *   → ["鶏むね肉 100g"]  (卵/醤油 are on hand, so excluded).
 */
export function computeShoppingList(
  ingredients: readonly string[] | undefined,
  onHand: readonly string[] | undefined,
): string[] {
  if (!ingredients || ingredients.length === 0) return [];
  const haveNorm = (onHand ?? [])
    .map(normalizeIngredient)
    .filter((s) => s.length > 0);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ingredients) {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (!line) continue;
    const norm = normalizeIngredient(line);
    if (!norm || seen.has(norm)) continue; // de-dupe by normalised name
    // Skip when something on hand covers it — "あるものは買い物リストに入れない".
    if (haveNorm.some((have) => onHandCovers(norm, have))) {
      seen.add(norm);
      continue;
    }
    seen.add(norm);
    out.push(line);
  }
  return out;
}

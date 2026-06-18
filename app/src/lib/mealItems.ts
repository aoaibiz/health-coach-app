// Per-item meal granularity (Phase 4) — the CLIENT-SIDE half of the grounding
// contract. Lets the user fine-tune each item's portion/quantity and recompute
// kcal/PFC live, then sum a precise meal total.
//
// ┌─ ANTI-FABRICATION CONTRACT (mirrors functions/_lib/ground.ts) ────────────┐
// │ db       → recompute from the official per-100g basis: perGram × g/100.   │
// │             NEVER scale the model's number; the DB is the source.          │
// │ label    → scale PROPORTIONALLY from the model's original figure, stays    │
// │             labelled ラベル値. (The label was read for the model's grams.)  │
// │ estimate → scale PROPORTIONALLY from the model's original figure, stays     │
// │             labelled 推定値. An estimate is NEVER presented as 公式DB.       │
// └────────────────────────────────────────────────────────────────────────────┘
//
// Manual-add grounding reuses the SAME matcher as analysis (functions/_lib
// ground.findFood) against the bundled MEXT DB: a DB match → 公式DB (with its
// per-100g basis), otherwise a labelled 推定値 manual item. Never fabricated.

import type {
  FoodBasisPer100g,
  MealItem,
  MealNutrition,
  NutritionSourceKind,
} from "./types";

/** One decimal place, matching the server-side grounding rounding. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Clamp a grams value to a sane, non-negative range (mirrors clampGrams). */
export function clampGrams(grams: number): number {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  return Math.min(grams, 10000);
}

/** Clamp a quantity multiplier to a sane positive range. */
export function clampQty(qty: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 1;
  return Math.min(qty, 999);
}

/** The effective edible weight of an item (per-unit grams × quantity). */
export function effectiveGrams(item: Pick<MealItem, "grams" | "qty">): number {
  return clampGrams(clampGrams(item.grams) * clampQty(item.qty));
}

/**
 * Recompute an item's kcal/PFC for its current effective weight (grams × qty).
 *
 *  - db: kcal/PFC = basisPer100g × effectiveGrams / 100 — EXACT, from the DB.
 *  - label/estimate: scale the model's original figure proportionally
 *    (newKcal = baseKcal × effectiveGrams / baseGrams), keeping the source label.
 *
 * Returns a NEW item with refreshed numbers; never mutates the input and never
 * turns an estimate into a 公式DB number.
 */
export function recomputeItem(item: MealItem): MealItem {
  const grams = effectiveGrams(item);

  if (item.sourceKind === "db" && item.basisPer100g) {
    const b = item.basisPer100g;
    const f = grams / 100;
    return {
      ...item,
      kcal: round1(b.kcal * f),
      proteinG: round1(b.proteinG * f),
      fatG: round1(b.fatG * f),
      carbG: round1(b.carbG * f),
    };
  }

  // label / estimate: proportional scale from the model's original anchor.
  const baseGrams = item.baseGrams && item.baseGrams > 0 ? item.baseGrams : null;
  if (baseGrams == null) {
    // No anchor to scale from — leave the numbers as-is (defensive).
    return { ...item };
  }
  const scale = grams / baseGrams;
  const scaleOrNull = (v: number | null | undefined): number | null =>
    v == null ? null : round1(v * scale);
  return {
    ...item,
    kcal: scaleOrNull(item.baseKcal),
    proteinG: scaleOrNull(item.baseProteinG),
    fatG: scaleOrNull(item.baseFatG),
    carbG: scaleOrNull(item.baseCarbG),
  };
}

/** Set an item's per-unit grams and recompute (qty unchanged). */
export function setItemGrams(item: MealItem, grams: number): MealItem {
  return recomputeItem({ ...item, grams: clampGrams(grams) });
}

/** Set an item's quantity multiplier and recompute (per-unit grams unchanged). */
export function setItemQty(item: MealItem, qty: number): MealItem {
  return recomputeItem({ ...item, qty: clampQty(qty) });
}

/**
 * Build a MealItem from analysis output, capturing the recompute anchor:
 *  - db items carry `basisPer100g` (exact recompute).
 *  - label/estimate items capture the model's original grams + numbers as the
 *    proportional-scale anchor (`baseGrams`/`baseKcal`/…).
 * The provided kcal/PFC are for `grams` at qty=1 (the analysis portion).
 */
export function toMealItem(input: {
  id: string;
  name: string;
  grams: number;
  kcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbG: number | null;
  sourceKind: NutritionSourceKind;
  source?: string;
  confidence?: MealItem["confidence"];
  foodCode?: string;
  basisPer100g?: FoodBasisPer100g;
}): MealItem {
  const grams = clampGrams(input.grams);
  const base: MealItem = {
    id: input.id,
    name: input.name,
    grams,
    qty: 1,
    kcal: input.kcal,
    proteinG: input.proteinG,
    fatG: input.fatG,
    carbG: input.carbG,
    sourceKind: input.sourceKind,
    source: input.source,
    confidence: input.confidence,
  };
  if (input.sourceKind === "db" && input.basisPer100g) {
    base.basisPer100g = input.basisPer100g;
  } else {
    // label / estimate: anchor the proportional scale to the model's figure.
    base.baseGrams = grams;
    base.baseKcal = input.kcal;
    base.baseProteinG = input.proteinG;
    base.baseFatG = input.fatG;
    base.baseCarbG = input.carbG;
  }
  // Recompute once so the stored numbers match grams×qty exactly.
  return recomputeItem(base);
}

/** Lowest confidence across items that produced a number (honest summary). */
function summarizeItemConfidence(items: MealItem[]): MealItem["confidence"] {
  const order = { low: 0, medium: 1, high: 2 } as const;
  const numbered = items.filter((i) => i.kcal != null && i.confidence);
  if (numbered.length === 0) return "low";
  return numbered.reduce<MealItem["confidence"]>(
    (acc, i) =>
      i.confidence && acc && order[i.confidence] < order[acc] ? i.confidence : acc,
    "high",
  );
}

/**
 * The dominant source kind for the per-meal badge (same rule as analysis):
 *   any estimate → "estimate"; else any label → "label"; else "db".
 * Computed over items that contributed a number.
 */
function dominantSourceKind(items: MealItem[]): NutritionSourceKind {
  const numbered = items.filter((i) => i.kcal != null);
  if (numbered.some((i) => i.sourceKind === "estimate")) return "estimate";
  if (numbered.some((i) => i.sourceKind === "label")) return "label";
  return "db";
}

/**
 * Sum the per-item numbers into a meal nutrition + derive the source flags.
 * Carries the editable `items` so a saved meal keeps its breakdown. Preserves
 * the existing `source`/`generatedBy` strings (passed via `meta`) for the badge.
 */
export function itemsToNutrition(
  items: MealItem[],
  meta?: { source?: string; generatedBy?: string },
): MealNutrition {
  const numbered = items.filter((i) => i.kcal != null);
  const sum = numbered.reduce(
    (acc, i) => ({
      calories: acc.calories + (i.kcal ?? 0),
      proteinG: acc.proteinG + (i.proteinG ?? 0),
      fatG: acc.fatG + (i.fatG ?? 0),
      carbG: acc.carbG + (i.carbG ?? 0),
    }),
    { calories: 0, proteinG: 0, fatG: 0, carbG: 0 },
  );
  // Prefer a 公式DB source string for the badge; else the first sourced item.
  const dbSource = numbered.find((i) => i.sourceKind === "db" && i.source)?.source;
  const anySource = numbered.find((i) => i.source)?.source;
  return {
    calories: round1(sum.calories),
    proteinG: round1(sum.proteinG),
    fatG: round1(sum.fatG),
    carbG: round1(sum.carbG),
    source: meta?.source ?? dbSource ?? anySource ?? undefined,
    confidence: summarizeItemConfidence(items),
    generatedBy: meta?.generatedBy,
    estimated: numbered.some((i) => i.sourceKind !== "db"),
    sourceKind: dominantSourceKind(items),
    items,
  };
}

/** A common-portion preset: a label + the grams it sets for a named food. */
export interface PortionPreset {
  label: string;
  grams: number;
}

/**
 * A small, light set of presets for very common Japanese foods. Matched by a
 * substring of the item name (normalized loosely). Intentionally tiny — this is
 * a convenience, not a second food DB. The grams are widely-cited household
 * portions, applied to the item's per-unit grams (qty handles multiples).
 */
export const PORTION_PRESETS: Array<{ match: RegExp; presets: PortionPreset[] }> = [
  {
    match: /ごはん|ご飯|白米|米飯|めし/,
    presets: [
      { label: "茶碗1杯 (150g)", grams: 150 },
      { label: "大盛 (250g)", grams: 250 },
      { label: "小盛 (100g)", grams: 100 },
    ],
  },
  {
    match: /食パン|トースト/,
    presets: [
      { label: "6枚切1枚 (60g)", grams: 60 },
      { label: "8枚切1枚 (45g)", grams: 45 },
    ],
  },
  {
    match: /卵|たまご|タマゴ|玉子/,
    presets: [{ label: "1個 (50g)", grams: 50 }],
  },
];

/** Presets applicable to an item name (empty when none match). */
export function presetsForName(name: string): PortionPreset[] {
  const entry = PORTION_PRESETS.find((p) => p.match.test(name));
  return entry?.presets ?? [];
}

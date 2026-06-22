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
import { scaleMicros, sumMicros, type Micros } from "../../functions/_lib/micros";

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
    // Extra nutrients are NULLABLE on the basis (the DB row may not measure them,
    // saturated fat is never in the bundled table): scale only when present, else
    // carry null (recompute → null → "—" in the UI, never a fabricated 0).
    const scaleOrNull = (v: number | null | undefined): number | null =>
      v == null ? null : round1(v * f);
    return {
      ...item,
      kcal: round1(b.kcal * f),
      proteinG: round1(b.proteinG * f),
      fatG: round1(b.fatG * f),
      carbG: round1(b.carbG * f),
      fiberG: scaleOrNull(b.fiberG),
      sugarG: scaleOrNull(b.sugarG),
      sodiumMg: scaleOrNull(b.sodiumMg),
      saturatedFatG: scaleOrNull(b.saturatedFatG),
      // Vitamins/minerals (拡張①): scaled from the per-100g basis micros (null per
      // unmeasured key → "—"); undefined when the basis carries none.
      micros: scaleMicros(b.micros, f),
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
    fiberG: scaleOrNull(item.baseFiberG),
    sugarG: scaleOrNull(item.baseSugarG),
    sodiumMg: scaleOrNull(item.baseSodiumMg),
    saturatedFatG: scaleOrNull(item.baseSaturatedFatG),
    // Vitamins/minerals (拡張①): proportional scale from the model's anchor micros.
    micros: scaleMicros(item.baseMicros, scale),
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
  /** Extra nutrients (optional/nullable) for `grams` at qty=1; null when unknown. */
  fiberG?: number | null;
  sugarG?: number | null;
  sodiumMg?: number | null;
  saturatedFatG?: number | null;
  /** Vitamins/minerals (拡張①) for `grams` at qty=1; nullable per key, absent → undefined. */
  micros?: Micros;
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
    fiberG: input.fiberG ?? null,
    sugarG: input.sugarG ?? null,
    sodiumMg: input.sodiumMg ?? null,
    saturatedFatG: input.saturatedFatG ?? null,
    ...(input.micros ? { micros: input.micros } : {}),
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
    base.baseFiberG = input.fiberG ?? null;
    base.baseSugarG = input.sugarG ?? null;
    base.baseSodiumMg = input.sodiumMg ?? null;
    base.baseSaturatedFatG = input.saturatedFatG ?? null;
    // Anchor the model's micros (拡張①) for proportional recompute on edit.
    if (input.micros) base.baseMicros = input.micros;
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
/**
 * Sum a nullable EXTRA nutrient across the numbered items: null when NO item
 * carries it (so a meal of foods with no fiber figure shows fiber "—", not a fake
 * 0), else the sum over the items that DO. Mirrors the server's sumNullable in
 * functions/_lib/ground.ts. round1 for display parity.
 */
function sumExtra(items: MealItem[], pick: (i: MealItem) => number | null | undefined): number | null {
  const present = items
    .map(pick)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (present.length === 0) return null;
  return round1(present.reduce((a, b) => a + b, 0));
}

export function itemsToNutrition(
  items: MealItem[],
  meta?: { source?: string; generatedBy?: string },
): MealNutrition {
  const numbered = items.filter((i) => i.kcal != null);
  // kcal is summed over every numbered item (all have it by definition). PFC are
  // summed ONLY over items that actually carry each macro (sumExtra), so a
  // kcal-only estimate item adds its kcal but never a fabricated 0 protein, and a
  // meal with no macro figures at all reports protein/fat/carb as null ("—").
  const calories = round1(numbered.reduce((acc, i) => acc + (i.kcal ?? 0), 0));
  // Prefer a 公式DB source string for the badge; else the first sourced item.
  const dbSource = numbered.find((i) => i.sourceKind === "db" && i.source)?.source;
  const anySource = numbered.find((i) => i.source)?.source;
  return {
    calories,
    proteinG: sumExtra(numbered, (i) => i.proteinG),
    fatG: sumExtra(numbered, (i) => i.fatG),
    carbG: sumExtra(numbered, (i) => i.carbG),
    // Extra nutrients summed only over items that carry them; null when none do.
    fiberG: sumExtra(numbered, (i) => i.fiberG),
    sugarG: sumExtra(numbered, (i) => i.sugarG),
    sodiumMg: sumExtra(numbered, (i) => i.sodiumMg),
    saturatedFatG: sumExtra(numbered, (i) => i.saturatedFatG),
    // Vitamin/mineral totals (拡張①): summed over numbered items that carry each
    // micro; null per key when none, undefined when no item carried any.
    micros: sumMicros(numbered.map((i) => i.micros)),
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

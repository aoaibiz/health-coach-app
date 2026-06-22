// Shared micronutrient definitions (拡張①「ビタミン・ミネラルまで網羅」).
//
// This is the SINGLE SOURCE OF TRUTH for the vitamin/mineral set carried through
// the whole nutrition pipeline (importer → lookup → ground → analyze → chat → UI).
// Both the server (functions/) and the client (src/, which already imports from
// functions/_lib) read these, so the key set + units + labels + display order can
// never drift between layers.
//
// ┌─ ANTI-FABRICATION CONTRACT (same as fiber/sugar/sodium) ───────────────────┐
// │ A micronutrient value is ALWAYS nullable. The MEXT table leaves many cells  │
// │ unmeasured, the model often can't read a micro off a label, and there is no │
// │ saturated-fat-style "assumed 0". So every micro is `number | null`:         │
// │   - DB per-100g basis → scaled to the portion ONLY when the row measured it,│
// │     else carries null (recompute → null → "—" in the UI, never a fake 0).   │
// │   - label/estimate → the model's sanitised figure, else null.               │
// │   - meal/day totals → summed ONLY over items that carry the micro; null when │
// │     none do (no fabricated "0µg ビタミンC" for a meal whose foods lack it).   │
// └────────────────────────────────────────────────────────────────────────────┘
//
// Why a keyed MAP and not ~18 flat fields: threading 18 individual fields through
// every interface, every per-100g basis, every scale loop and every sum loop
// would balloon the code and invite copy-paste drift. One key set + one loop per
// operation keeps the existing fiber/sugar/sodium semantics EXACTLY, at scale.

/** A micronutrient unit. Drives the UI suffix; the value is stored in this unit. */
export type MicroUnit = "mg" | "µg";

/** One micronutrient's identity: stable key, MEXT component id, JP label, unit. */
export interface MicroDef {
  /** Stable machine key (the map key everywhere). */
  key: string;
  /** MEXT 八訂 component identifier (row-12 header), for traceability/SOURCE.md. */
  component: string;
  /** Japanese display label (UI). */
  label: string;
  /** Unit the stored value is in. */
  unit: MicroUnit;
  /** Grouping for the UI ("ビタミン群" / "ミネラル群"). */
  group: "vitamin" | "mineral";
}

/**
 * The micronutrient set surfaced by the app, in display order within each group.
 * Keys are stable (used as map keys in storage); changing one is a data migration.
 * Units follow the MEXT table (mg or µg). saturated fat / fiber / sugar / sodium
 * stay on their existing dedicated fields (not here) — this set is the NEW
 * vitamins + the remaining major minerals beyond sodium.
 */
export const MICRO_DEFS: readonly MicroDef[] = [
  // ---- Vitamins -------------------------------------------------------------
  { key: "vitaminA", component: "VITA_RAE", label: "ビタミンA", unit: "µg", group: "vitamin" },
  { key: "vitaminD", component: "VITD", label: "ビタミンD", unit: "µg", group: "vitamin" },
  { key: "vitaminE", component: "TOCPHA", label: "ビタミンE", unit: "mg", group: "vitamin" },
  { key: "vitaminK", component: "VITK", label: "ビタミンK", unit: "µg", group: "vitamin" },
  { key: "vitaminB1", component: "THIA", label: "ビタミンB1", unit: "mg", group: "vitamin" },
  { key: "vitaminB2", component: "RIBF", label: "ビタミンB2", unit: "mg", group: "vitamin" },
  { key: "niacin", component: "NIA", label: "ナイアシン", unit: "mg", group: "vitamin" },
  { key: "vitaminB6", component: "VITB6A", label: "ビタミンB6", unit: "mg", group: "vitamin" },
  { key: "vitaminB12", component: "VITB12", label: "ビタミンB12", unit: "µg", group: "vitamin" },
  { key: "folate", component: "FOL", label: "葉酸", unit: "µg", group: "vitamin" },
  { key: "vitaminC", component: "VITC", label: "ビタミンC", unit: "mg", group: "vitamin" },
  // ---- Minerals (beyond sodium, which keeps its existing dedicated field) ----
  { key: "potassium", component: "K", label: "カリウム", unit: "mg", group: "mineral" },
  { key: "calcium", component: "CA", label: "カルシウム", unit: "mg", group: "mineral" },
  { key: "magnesium", component: "MG", label: "マグネシウム", unit: "mg", group: "mineral" },
  { key: "phosphorus", component: "P", label: "リン", unit: "mg", group: "mineral" },
  { key: "iron", component: "FE", label: "鉄", unit: "mg", group: "mineral" },
  { key: "zinc", component: "ZN", label: "亜鉛", unit: "mg", group: "mineral" },
  { key: "copper", component: "CU", label: "銅", unit: "mg", group: "mineral" },
] as const;

/** The stable key strings (the map keys used in storage + over the wire). */
export const MICRO_KEYS: readonly string[] = MICRO_DEFS.map((d) => d.key);

/** Lookup a definition by key (label/unit/group for the UI). */
const BY_KEY = new Map(MICRO_DEFS.map((d) => [d.key, d]));
export function microDef(key: string): MicroDef | undefined {
  return BY_KEY.get(key);
}

/**
 * A bag of micronutrient values, keyed by MICRO_KEYS. Every value is `number |
 * null` (null = honestly unknown, never a fabricated 0); a key may be absent
 * entirely (treated as null). Used for per-100g bases, per-item amounts, and
 * meal/day totals alike — the same shape everywhere, so one helper scales/sums.
 */
export type Micros = Record<string, number | null>;

/** One decimal place (matches the rest of the grounding rounding). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Scale a per-100g micros bag to a portion (factor = grams/100), keeping null
 * where the source has no figure. Returns undefined when the input is empty/
 * absent (so callers can omit the field rather than store an empty object).
 */
export function scaleMicros(per100: Micros | undefined | null, factor: number): Micros | undefined {
  if (!per100) return undefined;
  const out: Micros = {};
  let any = false;
  for (const key of MICRO_KEYS) {
    const v = per100[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = round1(v * factor);
      any = true;
    } else {
      out[key] = null;
    }
  }
  return any ? out : undefined;
}

/**
 * Sum a list of (nullable) micros bags: per key, null when NO bag carried it,
 * else the sum over the bags that DO (a bag missing one just doesn't add — an
 * honest partial total, mirroring fiber/sugar sumNullable). Returns undefined
 * when nothing across all bags carried any micro (so the field is omitted).
 */
export function sumMicros(bags: Array<Micros | undefined | null>): Micros | undefined {
  const out: Micros = {};
  let any = false;
  for (const key of MICRO_KEYS) {
    let sum = 0;
    let present = false;
    for (const bag of bags) {
      const v = bag?.[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        present = true;
      }
    }
    if (present) {
      out[key] = round1(sum);
      any = true;
    } else {
      out[key] = null;
    }
  }
  return any ? out : undefined;
}

/**
 * Clean a raw, untrusted micros object (e.g. from the model or the wire) into a
 * Micros bag bounded by a per-key ceiling: a finite, non-negative value ≤ ceil is
 * kept (rounded); anything else (missing/negative/NaN/absurd) → null. Returns
 * undefined when nothing usable, so the caller omits the field. `ceil(unit)`
 * supplies the unit-appropriate physical bound.
 */
export function cleanMicros(
  raw: unknown,
  ceil: (unit: MicroUnit) => number,
): Micros | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: Micros = {};
  let any = false;
  for (const def of MICRO_DEFS) {
    const v = r[def.key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= ceil(def.unit)) {
      out[def.key] = round1(v);
      any = true;
    } else {
      out[def.key] = null;
    }
  }
  return any ? out : undefined;
}

/** Whether a micros bag has at least one real (non-null) figure. */
export function hasAnyMicro(m: Micros | undefined | null): boolean {
  if (!m) return false;
  return MICRO_KEYS.some((k) => typeof m[k] === "number" && Number.isFinite(m[k] as number));
}

// Typed access to the bundled MEXT nutrition lookup.
//
// The JSON is generated at build time from data/nutrition/nutrition.sqlite by
// data/nutrition/build_lookup.py (per-100g figures). A CF Pages Function cannot
// open the SQLite file at request time, so we bundle this JSON instead and index
// it in memory once on first use.

import lookupJson from "./nutrition-lookup.json";
import { normalizeName } from "../_lib/normalize";

/** One per-100g food row from the MEXT table. */
export interface FoodEntry {
  food_code: string;
  /** Original Japanese name (may contain full-width brackets). */
  name_jp: string;
  /** Aggressive normalization (brackets stripped) — primary match key. */
  name_norm: string;
  /** NFKC+whitespace only (brackets kept) — used to disambiguate collisions. */
  name_full: string;
  /** kcal per 100g. */
  kcal: number;
  protein_g: number;
  fat_g: number;
  carb_g: number;
}

interface LookupFile {
  source: string;
  rowCount: number;
  entryCount: number;
  entries: FoodEntry[];
}

const data = lookupJson as unknown as LookupFile;

/** The data-source string every grounded estimate must carry (anti-fabrication). */
export const NUTRITION_SOURCE = data.source;

export const ENTRY_COUNT = data.entries.length;

/** name_norm -> all rows sharing that normalized name (preserves collisions). */
let byNorm: Map<string, FoodEntry[]> | null = null;

function index(): Map<string, FoodEntry[]> {
  if (byNorm) return byNorm;
  const map = new Map<string, FoodEntry[]>();
  for (const e of data.entries) {
    const list = map.get(e.name_norm);
    if (list) list.push(e);
    else map.set(e.name_norm, [e]);
  }
  byNorm = map;
  return map;
}

export function allEntries(): FoodEntry[] {
  return data.entries;
}

/** Exact-by-normalized-name lookup; returns every row that collides on name_norm. */
export function lookupByNorm(name: string): FoodEntry[] {
  return index().get(normalizeName(name)) ?? [];
}

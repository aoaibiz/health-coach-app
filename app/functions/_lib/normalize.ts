// Name normalization — a TypeScript mirror of `normalize_name` in
// data/nutrition/import_mext_nutrition.py, so a name the LLM returns is
// normalized exactly the way the bundled DB keys (`name_norm`) were built.
//
// Steps (must stay in sync with the Python importer):
//   1. Unicode NFKC (full-width → half-width, etc.)
//   2. strip parenthesized/bracketed text:  (...)  [...]  <...>
//      (full-width forms become half-width after NFKC, so one pass covers both)
//   3. collapse runs of whitespace to a single space
//   4. trim

/** Aggressive normalization matching the DB's `name_norm` column. */
export function normalizeName(name: string): string {
  let s = name.normalize("NFKC");
  s = s.replace(/\([^)]*\)/g, "");
  s = s.replace(/\[[^\]]*\]/g, "");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

/** Light normalization: NFKC + whitespace-collapse only (keeps bracket content). */
export function normalizeFull(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim();
}

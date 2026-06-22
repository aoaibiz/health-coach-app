#!/usr/bin/env python3
"""Build the bundled nutrition lookup the Cloudflare Pages Function imports.

Cloudflare Pages Functions cannot open a filesystem SQLite at request time, so
at *build time* we flatten the local MEXT database (data/nutrition/nutrition.sqlite,
per-100g) into a plain JSON map that the Function bundles statically.

Output: functions/_data/nutrition-lookup.json

Shape:
  {
    "source": "日本食品標準成分表（八訂）増補2023年から引用",
    "entries": [
       { "food_code", "name_jp", "name_norm", "name_full", "kcal",
         "protein_g", "fat_g", "carb_g",
         "fiber_g", "sugar_g", "sodium_mg", "salt_g" },
       ...
    ]
  }

`name_norm` is the DB's aggressive normalization (brackets/parens stripped) used
for the primary match. `name_full` keeps the bracket content (e.g. ［水稲めし］
vs ［水稲穀粒］) so the grounding logic can disambiguate two foods that collapse
to the same `name_norm` (raw rice 342kcal vs cooked rice 156kcal). We keep ALL
rows — no collapsing — so nothing is silently shadowed. Rows whose kcal is NULL
are skipped: we never ground against a row with no calorie figure (that would
risk fabricating "0 kcal").
"""
import re
import unicodedata
import json
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SQLITE_PATH = BASE_DIR / "nutrition.sqlite"
OUT_PATH = BASE_DIR.parent.parent / "functions" / "_data" / "nutrition-lookup.json"

SOURCE_TEXT = "日本食品標準成分表（八訂）増補2023年から引用"

# Vitamin/mineral columns (拡張①). MUST match MICRO_COLUMNS in
# import_mext_nutrition.py and MICRO_DEFS in functions/_lib/micros.ts. Emitted into
# each entry under a nested `micros` object; a value stays NULL when the DB row
# doesn't measure it (never a fabricated 0), exactly like fiber/sugar/sodium.
MICRO_KEYS: list[str] = [
    "vitaminA", "vitaminD", "vitaminE", "vitaminK",
    "vitaminB1", "vitaminB2", "niacin", "vitaminB6", "vitaminB12",
    "folate", "vitaminC",
    "potassium", "calcium", "magnesium", "phosphorus", "iron", "zinc", "copper",
]


def name_full(name: str) -> str:
    """NFKC + whitespace-collapse only — keeps bracket content for disambiguation."""
    normalized = unicodedata.normalize("NFKC", name)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()


def build() -> dict:
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    micro_select = ", ".join(MICRO_KEYS)
    rows = conn.execute(
        f"""
        SELECT food_code, name_jp, name_norm, kcal, protein_g, fat_g, carb_g,
               fiber_g, sugar_g, sodium_mg, salt_g, {micro_select}
        FROM foods
        ORDER BY food_code ASC
        """
    ).fetchall()
    conn.close()

    entries: list[dict] = []
    skipped_no_kcal = 0
    for r in rows:
        # Never ground against a row with no calorie figure.
        if r["kcal"] is None:
            skipped_no_kcal += 1
            continue
        if not r["name_norm"]:
            continue
        # ANTI-FABRICATION: the extra nutrients (fiber/sugar/sodium/salt) keep NULL
        # when the table does not measure them — they are NOT defaulted to 0 the way
        # PFC are. A null travels to the client as `null` so the UI honestly shows
        # "—" instead of inventing a zero. (kcal/PFC stay 0-defaulted as before so a
        # matched whole food always totals.)
        # Vitamins/minerals (拡張①) under a nested `micros` map. Each value keeps
        # NULL when the table doesn't measure it (never a fabricated 0). A row with
        # NO measured micro emits micros:null so the bundle stays compact.
        micros = {k: r[k] for k in MICRO_KEYS}
        has_micro = any(v is not None for v in micros.values())
        entries.append(
            {
                "food_code": r["food_code"],
                "name_jp": r["name_jp"],
                "name_norm": r["name_norm"],
                "name_full": name_full(r["name_jp"]),
                "kcal": r["kcal"],
                "protein_g": r["protein_g"] if r["protein_g"] is not None else 0.0,
                "fat_g": r["fat_g"] if r["fat_g"] is not None else 0.0,
                "carb_g": r["carb_g"] if r["carb_g"] is not None else 0.0,
                "fiber_g": r["fiber_g"],
                "sugar_g": r["sugar_g"],
                "sodium_mg": r["sodium_mg"],
                "salt_g": r["salt_g"],
                "micros": micros if has_micro else None,
            }
        )

    return {
        "source": SOURCE_TEXT,
        "rowCount": len(rows),
        "skippedNoKcal": skipped_no_kcal,
        "entryCount": len(entries),
        "entries": entries,
    }


def main() -> None:
    data = build()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"rows={data['rowCount']} entries={data['entryCount']} "
          f"skipped_no_kcal={data['skippedNoKcal']}")
    print(f"out={OUT_PATH}")


if __name__ == "__main__":
    main()

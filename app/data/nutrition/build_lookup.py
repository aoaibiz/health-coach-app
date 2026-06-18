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
         "protein_g", "fat_g", "carb_g" },
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


def name_full(name: str) -> str:
    """NFKC + whitespace-collapse only — keeps bracket content for disambiguation."""
    normalized = unicodedata.normalize("NFKC", name)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()


def build() -> dict:
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT food_code, name_jp, name_norm, kcal, protein_g, fat_g, carb_g
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

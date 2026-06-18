#!/usr/bin/env python3
import csv
import re
import sqlite3
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
XLSX_PATH = BASE_DIR / "20260327-mxt_kagsei-mext-000029402_02.xlsx"
SQLITE_PATH = BASE_DIR / "nutrition.sqlite"
SAMPLE_CSV_PATH = BASE_DIR / "nutrition-sample.csv"
SOURCE_MD_PATH = BASE_DIR / "SOURCE.md"

SOURCE_PAGE_URL = "https://www.mext.go.jp/a_menu/syokuhinseibun/mext_00001.html"
SOURCE_XLSX_URL = "https://www.mext.go.jp/content/20260327-mxt_kagsei-mext-000029402_02.xlsx"
SOURCE_TEXT = "日本食品標準成分表（八訂）増補2023年から引用"

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

GROUP_NAMES = {
    "01": "穀類",
    "02": "いも及びでん粉類",
    "03": "砂糖及び甘味類",
    "04": "豆類",
    "05": "種実類",
    "06": "野菜類",
    "07": "果実類",
    "08": "きのこ類",
    "09": "藻類",
    "10": "魚介類",
    "11": "肉類",
    "12": "卵類",
    "13": "乳類",
    "14": "油脂類",
    "15": "菓子類",
    "16": "し好飲料類",
    "17": "調味料及び香辛料類",
    "18": "調理済み流通食品類",
}


def col_to_idx(ref: str) -> int:
    letters = re.match(r"([A-Z]+)", ref).group(1)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def load_shared_strings(zip_file: zipfile.ZipFile) -> list[str]:
    root = ET.fromstring(zip_file.read("xl/sharedStrings.xml"))
    shared = []
    for si in root.findall(NS + "si"):
        shared.append("".join(t.text or "" for t in si.iter(NS + "t")))
    return shared


def cell_value(cell: ET.Element, shared: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(t.text or "" for t in cell.iter(NS + "t"))
    value = cell.find(NS + "v")
    if value is None:
        return ""
    raw = value.text or ""
    if cell_type == "s":
        return shared[int(raw)]
    return raw


def load_sheet_rows() -> dict[int, dict[int, str]]:
    with zipfile.ZipFile(XLSX_PATH) as zip_file:
        shared = load_shared_strings(zip_file)
        root = ET.fromstring(zip_file.read("xl/worksheets/sheet1.xml"))
        rows = {}
        for row in root.find(NS + "sheetData").findall(NS + "row"):
            row_num = int(row.attrib["r"])
            values = {}
            for cell in row.findall(NS + "c"):
                values[col_to_idx(cell.attrib["r"])] = cell_value(cell, shared)
            rows[row_num] = values
        return rows


def normalize_name(name: str) -> str:
    normalized = unicodedata.normalize("NFKC", name)
    normalized = re.sub(r"\([^)]*\)", "", normalized)
    normalized = re.sub(r"\[[^\]]*\]", "", normalized)
    normalized = re.sub(r"<[^>]*>", "", normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()


def parse_number(value: str) -> float | None:
    text = str(value).strip()
    if not text:
        return None
    if text in {"-", "－", "—", "...", "…", "*"}:
        return None
    if text.lower() == "tr":
        return 0.0
    text = text.replace(",", "")
    text = re.sub(r"^\((.*)\)$", r"\1", text)
    if text.lower() == "tr":
        return 0.0
    try:
        return float(text)
    except ValueError:
        return None


def parse_food_rows() -> list[dict[str, object]]:
    rows = load_sheet_rows()
    foods = []
    for row_num in sorted(rows):
        if row_num < 13:
            continue
        row = rows[row_num]
        food_code = str(row.get(2, "")).strip()
        name_jp = str(row.get(4, "")).strip()
        group_code = str(row.get(1, "")).strip().zfill(2)
        if not re.fullmatch(r"\d{5}", food_code) or not name_jp:
            continue
        foods.append(
            {
                "food_code": food_code,
                "name_jp": name_jp,
                "name_norm": normalize_name(name_jp),
                "kcal": parse_number(row.get(7, "")),
                "protein_g": parse_number(row.get(10, "")),
                "fat_g": parse_number(row.get(13, "")),
                "carb_g": parse_number(row.get(21, "")),
                "group_name": GROUP_NAMES.get(group_code, group_code),
                "source": SOURCE_TEXT,
            }
        )
    return foods


def write_sqlite(foods: list[dict[str, object]]) -> None:
    if SQLITE_PATH.exists():
        SQLITE_PATH.unlink()
    with sqlite3.connect(SQLITE_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE foods (
              food_code TEXT,
              name_jp TEXT,
              name_norm TEXT,
              kcal REAL,
              protein_g REAL,
              fat_g REAL,
              carb_g REAL,
              group_name TEXT,
              source TEXT
            )
            """
        )
        conn.execute("CREATE INDEX idx_foods_name_jp ON foods(name_jp)")
        conn.execute("CREATE INDEX idx_foods_name_norm ON foods(name_norm)")
        conn.executemany(
            """
            INSERT INTO foods (
              food_code, name_jp, name_norm, kcal, protein_g, fat_g, carb_g, group_name, source
            ) VALUES (
              :food_code, :name_jp, :name_norm, :kcal, :protein_g, :fat_g, :carb_g, :group_name, :source
            )
            """,
            foods,
        )


def write_sample_csv(foods: list[dict[str, object]]) -> None:
    columns = [
        "food_code",
        "name_jp",
        "name_norm",
        "kcal",
        "protein_g",
        "fat_g",
        "carb_g",
        "group_name",
        "source",
    ]
    with SAMPLE_CSV_PATH.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        writer.writerows(foods[:50])


def write_source_md() -> None:
    mtime = datetime.fromtimestamp(XLSX_PATH.stat().st_mtime).astimezone()
    SOURCE_MD_PATH.write_text(
        f"""# Nutrition Data Source

{SOURCE_TEXT}

- Entry page: {SOURCE_PAGE_URL}
- Downloaded Excel: {SOURCE_XLSX_URL}
- Local source file: `{XLSX_PATH.name}`
- Local source file mtime: {mtime.isoformat()}
- Workbook sheet: `表全体` (`xl/worksheets/sheet1.xml`)

## Adopted Columns

- `food_code`: 食品番号 (`A12:BJ2551` table, column B)
- `name_jp`: 食品名 (column D)
- `group_name`: 食品群 code (column A) mapped to the official food group names in this importer
- `kcal`: エネルギー kcal, component identifier `ENERC_KCAL` (column G). The kJ column `ENERC` is not used.
- `protein_g`: standard たんぱく質, component identifier `PROT-` (column J). `PROTCAA` is not used.
- `fat_g`: standard 脂質, component identifier `FAT-` (column M). `FATNLEA` is not used.
- `carb_g`: total 炭水化物, component identifier `CHOCDF-` (column U).
- `name_norm`: `name_jp` normalized with Unicode NFKC, parenthesized/bracketed text removed (`()`, `[]`, `<>`, including their full-width forms after NFKC), repeated whitespace collapsed, and surrounding whitespace stripped.

## Non-Numeric Normalization

- `Tr` is stored as `0.0`.
- `-`, blank, and other non-numeric placeholders are stored as `NULL`.
- Parenthesized numeric values are stored as their numeric value because the table uses parentheses for estimated or derived values.
""",
        encoding="utf-8",
    )


def main() -> None:
    foods = parse_food_rows()
    write_sqlite(foods)
    write_sample_csv(foods)
    write_source_md()
    print(f"foods={len(foods)}")
    print(f"sqlite={SQLITE_PATH}")
    print(f"sample_csv={SAMPLE_CSV_PATH}")
    print(f"source_md={SOURCE_MD_PATH}")


if __name__ == "__main__":
    main()

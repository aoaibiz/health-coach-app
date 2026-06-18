# Nutrition Data Source

日本食品標準成分表（八訂）増補2023年から引用

- Entry page: https://www.mext.go.jp/a_menu/syokuhinseibun/mext_00001.html
- Downloaded Excel: https://www.mext.go.jp/content/20260327-mxt_kagsei-mext-000029402_02.xlsx
- Local source file: `20260327-mxt_kagsei-mext-000029402_02.xlsx`
- Local source file mtime: 2026-06-17T06:09:51.641645+09:00
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

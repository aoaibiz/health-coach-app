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
- `fiber_g`: 食物繊維総量, component identifier `FIB-` (column S / index 19).
- `sugar_g`: 利用可能炭水化物（単糖当量）, component identifier `CHOAVLM` (column N / index 14). Used as the 糖質（糖類）参考値; the 八訂 table has no separate 糖類 column, so this available-carbohydrate figure is surfaced as the closest honest reference. NULL when not measured.
- `sodium_mg`: ナトリウム, component identifier `NA` (column X / index 24), in milligrams.
- `salt_g`: 食塩相当量, component identifier `NACL_EQ` (column BI / index 61), in grams.
- Vitamins + minerals (拡張①「ビタミン・ミネラルまで網羅」): each stored in its own REAL column, unit per the table (mg / µg). Component identifiers (row-12 成分識別子) and sheet column index:
  - `vitaminA`: component `VITA_RAE` (sheet column index 43).
  - `vitaminD`: component `VITD` (sheet column index 44).
  - `vitaminE`: component `TOCPHA` (sheet column index 45).
  - `vitaminK`: component `VITK` (sheet column index 49).
  - `vitaminB1`: component `THIA` (sheet column index 50).
  - `vitaminB2`: component `RIBF` (sheet column index 51).
  - `niacin`: component `NIA` (sheet column index 52).
  - `vitaminB6`: component `VITB6A` (sheet column index 54).
  - `vitaminB12`: component `VITB12` (sheet column index 55).
  - `folate`: component `FOL` (sheet column index 56).
  - `vitaminC`: component `VITC` (sheet column index 59).
  - `potassium`: component `K` (sheet column index 25).
  - `calcium`: component `CA` (sheet column index 26).
  - `magnesium`: component `MG` (sheet column index 27).
  - `phosphorus`: component `P` (sheet column index 28).
  - `iron`: component `FE` (sheet column index 29).
  - `zinc`: component `ZN` (sheet column index 30).
  - `copper`: component `CU` (sheet column index 31).
- `name_norm`: `name_jp` normalized with Unicode NFKC, parenthesized/bracketed text removed (`()`, `[]`, `<>`, including their full-width forms after NFKC), repeated whitespace collapsed, and surrounding whitespace stripped.

## Non-Numeric Normalization

- `Tr` is stored as `0.0`.
- `-`, blank, and other non-numeric placeholders are stored as `NULL`.
- Parenthesized numeric values are stored as their numeric value because the table uses parentheses for estimated or derived values.

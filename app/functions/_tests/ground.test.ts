import { describe, it, expect } from "vitest";
import {
  findFood,
  groundDish,
  groundDishes,
  NUTRITION_SOURCE,
  ENTRY_COUNT,
  MAX_ITEM_KCAL,
  SOURCE_LABEL,
  type IdentifiedDish,
} from "../_lib/ground";

// Reference per-100g values are the actual MEXT rows in nutrition.sqlite:
//   こめ [水稲めし] 精白米 うるち米 (cooked rice "ごはん"): 156 / 2.5 / 0.3 / 37.1
//   こめ [水稲穀粒] 精白米 うるち米 (raw grain):           342 / 6.1 / 0.9 / 77.6
//   鶏卵 全卵 生 (raw egg):                                142 / 12.2 / 10.2 / 0.4

describe("findFood — DB lookup + disambiguation", () => {
  it("finds an exact normalized name", () => {
    const f = findFood("こめ 精白米 うるち米 めし");
    expect(f).not.toBeNull();
    // The cooked-rice row (156kcal) should win over the raw grain (342kcal)
    // because the query mentions めし / 水稲めし.
    expect(f?.kcal).toBe(156);
  });

  it("prefers cooked rice for the normalized rice collision when cooking state is absent", () => {
    const f = findFood("こめ 精白米 うるち米");
    expect(f).not.toBeNull();
    expect(f?.food_code).toBe("01088");
    expect(f?.kcal).toBe(156);
  });

  it("grounds everyday aliases to verified food_code rows", () => {
    expect(findFood("ごはん")?.food_code).toBe("01088");
    expect(findFood("めし")?.food_code).toBe("01088");
    expect(findFood("食パン")?.food_code).toBe("01026");
    expect(findFood("卵")?.food_code).toBe("12004");
    expect(findFood("鶏むね肉")?.food_code).toBe("11288");
    expect(findFood("鶏むね肉 皮なし")?.food_code).toBe("11288");
    expect(findFood("鶏肉")?.food_code).toBe("11221");
    expect(findFood("玉ねぎ")?.food_code).toBe("06153");
    expect(findFood("うどん")?.food_code).toBe("01039");
    expect(findFood("人参")?.food_code).toBe("06214");
    expect(findFood("ウインナー")?.food_code).toBe("11186");
    expect(findFood("油揚げ")?.food_code).toBe("04040");
  });

  it("downgrades representative generic-meat aliases", () => {
    const item = groundDish({ name: "鶏肉", grams: 100, confidence: "high" });
    expect(item.matched).toBe(true);
    expect(item.matchedCode).toBe("11221");
    expect(item.confidence).toBe("medium");
  });

  it("does not fuzzy-ground generic one-word fragments", () => {
    expect(findFood("むね")).toBeNull();
    expect(findFood("こめ")).toBeNull();
  });

  it("returns null for a dish with no DB match (no fabrication)", () => {
    expect(findFood("架空のごちそうXYZ")).toBeNull();
    expect(findFood("")).toBeNull();
  });
});

describe("single-token substring match — specific names ground, generic ones don't", () => {
  it("grounds a specific single token to the verbose DB row (most basic form)", () => {
    // "さつまいも" must resolve to "…さつまいも 塊根 皮なし 生" (NOT 天ぷら/でん粉).
    const imo = groundDish({ name: "さつまいも", grams: 100 });
    expect(imo.matched).toBe(true);
    expect(imo.matchedCode).toBe("02006"); // 皮なし 生
    expect(imo.kcal).toBeGreaterThan(0);

    // An un-aliased single token grounds via substring to the most basic form,
    // never a derivative product (しいたけ must NOT become しいたけだし).
    const shiitake = groundDish({ name: "しいたけ", grams: 100 });
    expect(shiitake.matched).toBe(true);
    expect(shiitake.matchedCode).toBe("08039"); // 生しいたけ 生
    expect(shiitake.matchedName).not.toContain("だし");
    expect(shiitake.kcal).toBeGreaterThan(0);

    const renkon = groundDish({ name: "れんこん", grams: 100 });
    expect(renkon.matched).toBe(true);
    expect(renkon.matchedName).toContain("生");
    expect(renkon.kcal).toBeGreaterThan(0);
  });

  it("single-token substring matches are medium confidence (one token only)", () => {
    // しいたけ/れんこん are NOT aliased, so they ground via the single-token
    // substring path → medium. (さつまいも IS an alias → high; asserted below.)
    expect(groundDish({ name: "しいたけ", grams: 100 }).confidence).toBe("medium");
    expect(groundDish({ name: "れんこん", grams: 100 }).confidence).toBe("medium");
    // An explicit alias keeps its high confidence even though it's one token.
    expect(groundDish({ name: "さつまいも", grams: 100 }).confidence).toBe("high");
  });

  it("a generic 1-2 char single token still does NOT substring-match", () => {
    // These collide with dozens of unrelated rows — the specificity guard
    // (>=3 chars, not generic) keeps them unmatched, preventing false grounding.
    expect(findFood("むね")).toBeNull(); // にわとり むね …
    expect(findFood("こめ")).toBeNull(); // こめ 玄米 …
    expect(findFood("もも")).toBeNull(); // もも 白肉種 … / 鶏もも …
    expect(findFood("生")).toBeNull();
    expect(findFood("米")).toBeNull();
  });
});

describe("everyday-food aliases ground to verified food_code rows (kcal>0)", () => {
  it("newly-added staples/produce/seafood all match the bundled DB", () => {
    const cases: Array<[string, string]> = [
      ["さつまいも", "02006"],
      ["里芋", "02010"],
      ["かぼちゃ", "06048"],
      ["とうもろこし", "06175"],
      ["白菜", "06233"],
      ["もやし", "06291"],
      ["まぐろ", "10253"],
      ["あじ", "10003"],
      ["えび", "10321"],
      ["いか", "10345"],
      ["バター", "14017"],
      ["鮭", "10136"],
      ["バナナ", "07107"],
    ];
    for (const [name, code] of cases) {
      const item = groundDish({ name, grams: 100 });
      expect(item.matched, `${name} should match`).toBe(true);
      expect(item.matchedCode, `${name} -> ${code}`).toBe(code);
      expect(item.kcal, `${name} kcal>0`).toBeGreaterThan(0);
      expect(item.source).toBe(NUTRITION_SOURCE);
    }
  });
});

describe("beverage aliases — drinks ground to 公式DB (coffee bug fix)", () => {
  // Reference rows (verified in functions/_data/nutrition-lookup.json):
  //   16045 コーヒー 浸出液 = 4kcal/100g   ← brewed black coffee
  //   15088 ゼリー コーヒー = 43kcal/100g  ← coffee JELLY (the old WRONG match)
  it("ブラックコーヒー / コーヒー → 16045 コーヒー 浸出液, a NON-ZERO 公式DB value", () => {
    for (const name of ["ブラックコーヒー", "コーヒー", "ホットコーヒー", "アイスコーヒー"]) {
      const item = groundDish({ name, grams: 200 });
      expect(item.matched, `${name} should be a DB match`).toBe(true);
      expect(item.sourceKind, `${name} is 公式DB, not estimate`).toBe("db");
      expect(item.matchedCode, `${name} -> 16045 (brewed coffee), not 15088 (jelly)`).toBe(
        "16045",
      );
      // 4kcal/100g × 200g = 8kcal — non-zero, was 0 / "取得できませんでした" before.
      expect(item.kcal, `${name} kcal is real, not 0/null`).toBe(8);
      expect(item.source).toBe(NUTRITION_SOURCE);
    }
  });

  it("the bare コーヒー no longer mis-matches the coffee JELLY dessert (15088)", () => {
    // Regression guard: before the alias, the single-token substring matcher
    // grabbed 15088 ゼリー コーヒー (43kcal) for "コーヒー" — a confidently WRONG food.
    const item = groundDish({ name: "コーヒー", grams: 100 });
    expect(item.matchedCode).not.toBe("15088");
    expect(item.matchedName).not.toContain("ゼリー");
  });

  it("common teas/soft drinks/alcohol ground to verified beverage rows (kcal≥0, 公式DB)", () => {
    const cases: Array<[string, string]> = [
      ["緑茶", "16037"],
      ["お茶", "16037"],
      ["麦茶", "16055"],
      ["紅茶", "16044"],
      ["ウーロン茶", "16042"],
      ["コーラ", "16053"],
      ["ビール", "16006"],
      ["豆乳", "04052"],
      ["カフェオレ", "13007"],
      ["オレンジジュース", "07043"],
      ["りんごジュース", "07150"],
    ];
    for (const [name, code] of cases) {
      const item = groundDish({ name, grams: 100 });
      expect(item.matched, `${name} should match`).toBe(true);
      expect(item.sourceKind, `${name} is 公式DB`).toBe("db");
      expect(item.matchedCode, `${name} -> ${code}`).toBe(code);
      expect(item.kcal, `${name} kcal is a real DB number`).not.toBeNull();
      expect(item.source).toBe(NUTRITION_SOURCE);
    }
  });

  it("a genuinely-unknown drink still returns no DB match (never fabricated)", () => {
    expect(findFood("謎のエナジードリンクXYZ123")).toBeNull();
  });
});

describe("cooking-method names ground to the CORRECT prepared DB variant", () => {
  // Reference rows (verified in functions/_data/nutrition-lookup.json):
  //   02006 さつまいも 塊根 皮なし 生   = 126
  //   02007 さつまいも 塊根 皮なし 蒸し = 131
  //   02008 さつまいも 塊根 皮なし 焼き = 151
  it("焼きさつまいも / 焼き芋 / 焼きいも → the 焼き variant (02008, real kcal)", () => {
    for (const name of ["焼きさつまいも", "焼き芋", "焼きいも", "やきいも"]) {
      const item = groundDish({ name, grams: 100 });
      expect(item.matched, `${name} should be a DB match`).toBe(true);
      expect(item.sourceKind).toBe("db");
      expect(item.matchedCode, `${name} -> 02008`).toBe("02008");
      expect(item.matchedName).toContain("焼き");
      expect(item.kcal, `${name} kcal is real, not null/0`).toBe(151);
      expect(item.source).toBe(NUTRITION_SOURCE);
    }
  });

  it("蒸しさつまいも / ふかし芋 → the 蒸し variant (02007, real kcal)", () => {
    for (const name of ["蒸しさつまいも", "ふかし芋", "蒸し芋"]) {
      const item = groundDish({ name, grams: 100 });
      expect(item.matched, `${name} should be a DB match`).toBe(true);
      expect(item.matchedCode, `${name} -> 02007`).toBe("02007");
      expect(item.matchedName).toContain("蒸し");
      expect(item.kcal).toBe(131);
    }
  });

  it("plain さつまいも still grounds to 生 (02006), unchanged", () => {
    const item = groundDish({ name: "さつまいも", grams: 100 });
    expect(item.matchedCode).toBe("02006");
    expect(item.kcal).toBe(126);
  });

  it("the cooking-variant normalizer generalizes to other single foods with a DB variant", () => {
    // ゆで卵 / 茹で卵 → 鶏卵 全卵 ゆで (12005, 134) — via curated alias.
    expect(findFood("ゆで卵")?.food_code).toBe("12005");
    expect(findFood("茹で卵")?.food_code).toBe("12005");
    // 焼き鮭 / 焼きさば → the baked-fish rows (curated aliases), never raw.
    expect(findFood("焼き鮭")?.food_code).toBe("10136");
    expect(findFood("焼き鮭")?.kcal).toBe(160);
    // 焼きまあじ → the 焼き variant of まあじ via the structural-swap normalizer
    // (まあじ is not a curated alias of this exact form). It must be a 焼き row.
    const aji = findFood("焼きまあじ");
    expect(aji).not.toBeNull();
    expect(aji?.name_jp).toContain("焼き");
    expect(aji?.name_jp).toContain("あじ");
  });
});

describe("FABRICATION GUARD — compound dishes must NOT strip to a base ingredient", () => {
  // The single hardest constraint: 焼きそば(yakisoba) ≠ そば, 焼き肉 ≠ 肉,
  // 焼き鳥 ≠ 鳥. A confident WRONG match is worse than an honest 推定. Assert
  // none of these resolve to the base ingredient's DB row.
  it("焼きそば still grounds to its verified curated row (01188), NOT そば (01128)", () => {
    const f = findFood("焼きそば");
    // 焼きそば is a denylisted compound dish, but it has an explicit verified
    // alias (01188 こむぎ 蒸し中華めん ソテー = 211kcal), matched in step 1 BEFORE
    // the compound-dish guard — so it must STILL resolve correctly (non-regression).
    expect(f?.food_code).toBe("01188");
    expect(f?.kcal).toBe(211);
    expect(f?.food_code).not.toBe("01128"); // never boiled-buckwheat そば
    expect(f?.name_jp ?? "").not.toContain("そば　そば");
  });

  it("焼き肉 → honest 推定/null, NOT the 焼き肉のたれ SAUCE row (17113)", () => {
    // PRE-EXISTING BUG (Codex-found): the step-2.5 single-token substring matcher
    // ran BEFORE the compound-dish denylist and grabbed 17113 焼き肉のたれ — a
    // SAUCE — giving 焼き肉 the sauce's calories. A confident WRONG food is worse
    // than an honest 推定. The denylist now runs BEFORE step 2.5, so 焼き肉 (which
    // has no genuine grilled-meat dish row in the DB) falls to null → 推定.
    const f = findFood("焼き肉");
    expect(f).toBeNull();
    // groundDish: with no model number it is an honest no-data item, never a sauce.
    const item = groundDish({ name: "焼き肉", grams: 100, source: "db" });
    expect(item.matched).toBe(false);
    expect(item.matchedCode).toBeUndefined();
  });

  it("焼き鳥 → honest 推定/null, NOT the 焼き鳥のたれ sauce (17112) nor 焼き鳥缶詰 (11237)", () => {
    // Same pre-existing bug: 焼き鳥 would grab 17112 焼き鳥のたれ (sauce) via the
    // substring matcher. The DB has no clean grilled-chicken-skewer dish row
    // (only a sauce and a canned-product derivative), so it must fall to 推定.
    const f = findFood("焼き鳥");
    expect(f).toBeNull();
    const item = groundDish({ name: "焼き鳥", grams: 100, source: "db" });
    expect(item.matched).toBe(false);
    expect(item.matchedCode).toBeUndefined();
  });

  it("焼きうどん / お好み焼き do NOT strip to the noodle/base ingredient", () => {
    // 焼きうどん has no dedicated row → honest 推定 (null), never うどん(01039).
    expect(findFood("焼きうどん")).toBeNull();
    // お好み焼き is a real dish (18053) — must NOT collapse to its ingredients.
    expect(findFood("お好み焼き")?.food_code).toBe("18053");
  });

  it("the normalizer only fires for a glued single-token method+food name", () => {
    // A bare cooking word alone never grounds anything.
    expect(findFood("焼き")).toBeNull();
    expect(findFood("蒸し")).toBeNull();
    // A made-up food with a cooking prefix stays honest (no base to anchor to).
    expect(findFood("焼き架空料理ZZZ")).toBeNull();
  });
});

describe("compound-dish denylist — DB-verified aliases match, sauce-only dishes stay 推定", () => {
  // Every food_code below was verified against functions/_data/nutrition-lookup.json.
  // Dishes WITH a genuine DB dish row (NOT a sauce/derivative) ground via alias;
  // dishes whose ONLY containing row is a sauce/derivative or that have no clean
  // row fall to honest 推定 (null) — never a confidently WRONG food.
  it("denylisted dishes WITH a verified DB row still ground (non-regression)", () => {
    const matchable: Array<[string, string, number]> = [
      ["焼きそば", "01188", 211], // 蒸し中華めん ソテー
      ["焼きおにぎり", "01112", 166], // こめ 焼きおにぎり
      ["焼き飯", "18057", 206], // チャーハン
      ["チャーハン", "18057", 206],
      ["卵焼き", "12018", 146], // たまご焼 厚焼きたまご
      ["厚焼き卵", "12018", 146],
      ["だし巻き卵", "12019", 123], // たまご焼 だし巻きたまご
      ["どら焼き", "15027", 292], // どら焼 つぶしあん入り
      ["今川焼き", "15005", 217], // 今川焼 こしあん入り
      ["しゅうまい", "18012", 191], // 中国料理 しゅうまい
      ["焼き餃子", "18002", 209], // 中国料理 ぎょうざ
      ["お好み焼き", "18053", 136], // 和風料理 お好み焼き
    ];
    for (const [name, code, kcal] of matchable) {
      const f = findFood(name);
      expect(f?.food_code, `${name} -> ${code}`).toBe(code);
      expect(f?.kcal, `${name} kcal=${kcal}`).toBe(kcal);
    }
  });

  it("denylisted dishes with ONLY a sauce/derivative/no clean row → honest null (推定)", () => {
    // 焼き肉/焼き鳥: only a sauce (17113/17112) or a derivative (焼き鳥缶詰 11237)
    // exists — never grab those. たこ焼き/茶碗蒸し/蒸しパン/もんじゃ焼き/たい焼き/
    // 焼きうどん/焼きビーフン have no clean DB dish row at all.
    for (const name of [
      "焼き肉",
      "焼き鳥",
      "たこ焼き",
      "茶碗蒸し",
      "蒸しパン",
      "もんじゃ焼き",
      "たい焼き",
      "焼きうどん",
      "焼きビーフン",
    ]) {
      expect(findFood(name), `${name} must fall to 推定 (null)`).toBeNull();
    }
  });

  it("cooking-variant non-regression: 焼きさつまいも → 02008 (151), さつまいも → 02006 (126)", () => {
    // The compound-dish guard must NOT regress the legitimate cooking-variant
    // path (焼きさつまいも is NOT denylisted — it is method+single-ingredient).
    const yaki = groundDish({ name: "焼きさつまいも", grams: 100 });
    expect(yaki.matched).toBe(true);
    expect(yaki.matchedCode).toBe("02008");
    expect(yaki.kcal).toBe(151);
    const plain = groundDish({ name: "さつまいも", grams: 100 });
    expect(plain.matchedCode).toBe("02006");
    expect(plain.kcal).toBe(126);
  });
});

describe("groundDish — known dish grounds to DB numbers × grams/100", () => {
  it('"ごはん" 150g → ~156kcal/100g × 1.5', () => {
    const dish: IdentifiedDish = {
      name: "ごはん",
      grams: 150,
      confidence: "medium",
    };
    const item = groundDish(dish);
    expect(item.matched).toBe(true);
    // 156 * 1.5 = 234 ; 2.5*1.5=3.75 ; 0.3*1.5=0.45 ; 37.1*1.5=55.65
    expect(item.kcal).toBe(234);
    expect(item.protein_g).toBeCloseTo(3.8, 1);
    expect(item.fat_g).toBeCloseTo(0.5, 1);
    expect(item.carb_g).toBeCloseTo(55.7, 1);
    expect(item.source).toBe(NUTRITION_SOURCE);
    expect(item.source).toContain("日本食品標準成分表");
    expect(item.confidence).toBe("high");
    expect(item.matchedCode).toBe("01088");
    // The per-100g basis is exposed so the client can recompute on a portion
    // edit EXACTLY from the official DB (never from a scaled model number). The
    // extra nutrients (fiber/sugar/sodium) come from the DB row too; saturated
    // fat is not in the bundled table → always null for a 公式DB item. The
    // vitamins/minerals (拡張①) ride along in a nested `micros` map.
    expect(item.basisPer100g).toMatchObject({
      kcal: 156,
      protein_g: 2.5,
      fat_g: 0.3,
      carb_g: 37.1,
      fiber_g: 1.5,
      sugar_g: 38.1,
      sodium_mg: 1,
      saturated_fat_g: null,
    });
    // The grounded item carries the portion-scaled extra nutrients (×1.5 for 150g).
    expect(item.fiber_g).toBeCloseTo(2.3, 1); // 1.5 * 1.5 = 2.25 → 2.3 (round1)
    expect(item.sodium_mg).toBeCloseTo(1.5, 1); // 1 * 1.5
    expect(item.saturated_fat_g).toBeNull(); // not in the bundled table
    // 拡張① — vitamins/minerals are present on the basis (per 100g) and scaled on
    // the item (×1.5). ごはん 01088 has potassium 29mg/100g per the MEXT table.
    expect(item.basisPer100g?.micros?.potassium).toBe(29);
    expect(item.micros?.potassium).toBeCloseTo(43.5, 1); // 29 * 1.5
  });

  it("scales linearly with grams (100g → exactly per-100g values)", () => {
    const item = groundDish({ name: "鶏卵 全卵 生", grams: 100 });
    expect(item.matched).toBe(true);
    expect(item.kcal).toBe(142);
    expect(item.protein_g).toBe(12.2);
    expect(item.fat_g).toBe(10.2);
    expect(item.carb_g).toBe(0.4);
  });

  it("strong fuzzy matches are allowed but downgraded to low confidence", () => {
    const item = groundDish({ name: "鶏卵 全卵", grams: 100, confidence: "high" });
    expect(item.matched).toBe(true);
    expect(item.kcal).toBe(142);
    expect(item.source).toBe(NUTRITION_SOURCE);
    expect(item.confidence).toBe("low");
  });
});

describe("FABRICATION GUARD — unmatched dishes carry NO numbers", () => {
  it("unmatched dish → matched:false, all numbers null, low confidence, no source", () => {
    const item = groundDish({ name: "架空のごちそうXYZ", grams: 300, confidence: "high" });
    expect(item.matched).toBe(false);
    expect(item.kcal).toBeNull();
    expect(item.protein_g).toBeNull();
    expect(item.fat_g).toBeNull();
    expect(item.carb_g).toBeNull();
    expect(item.source).toBeNull();
    // Even if the LLM was "high" confidence, an unmatched dish is downgraded.
    expect(item.confidence).toBe("low");
  });

  it("a grounded number is never produced without a DB source string", () => {
    const matched = groundDish({ name: "鶏卵 全卵 生", grams: 50 });
    const unmatched = groundDish({ name: "存在しない料理", grams: 50 });
    for (const macro of ["kcal", "protein_g", "fat_g", "carb_g"] as const) {
      expect(matched[macro]).not.toBeNull();
      expect(unmatched[macro]).toBeNull();
    }
    expect(matched.source).not.toBeNull();
    expect(unmatched.source).toBeNull();
  });

  it("zero/negative grams default to a standard single serving, grounded from the DB (not fabricated)", () => {
    // A missing/zero/negative portion for a MATCHED food now defaults to a single
    // serving — the SAME shared resolver the chat MEAL_LOG path uses — so the two
    // logging paths converge instead of one logging 0 kcal and the other 100g.
    // 鶏卵 全卵 生 isn't a named drink/staple, so it takes the generic default 100g.
    // The number is still the DB basis × the portion (142/100 × 100), never invented.
    const item = groundDish({ name: "鶏卵 全卵 生", grams: -5 });
    expect(item.grams).toBe(100); // generic single-serving default (no specific standard portion)
    expect(item.kcal).toBe(142); // 142/100g × 100g — DB-grounded, not fabricated
    expect(item.matched).toBe(true);
  });

  it("an unstated drink portion grounds to its SHARED standard serving (coach=AI consistency)", () => {
    // The bug Ao caught: ブラックコーヒー grounded to the same DB row (4kcal/100g) on
    // both paths, but each path guessed a different portion → 8 vs 10 kcal. With the
    // shared standard portion (coffee 1杯 = 200g), an unstated coffee is now 200g →
    // 8 kcal on the AI-analysis path, matching the coach path exactly.
    const item = groundDish({ name: "ブラックコーヒー", grams: 0 });
    expect(item.matched).toBe(true);
    expect(item.grams).toBe(200); // shared standard portion for a drink (1杯=200g)
    expect(item.kcal).toBe(8); // 4/100g × 200g — same as the coach path
  });
});

describe("groundDishes — totals sum only matched items", () => {
  it("totals exclude unmatched dishes", () => {
    const result = groundDishes([
      { name: "鶏卵 全卵 生", grams: 100 }, // 142 kcal
      { name: "架空のごちそうXYZ", grams: 500 }, // unmatched → 0 contribution
    ]);
    expect(result.matchedCount).toBe(1);
    expect(result.totals.kcal).toBe(142);
    expect(result.items).toHaveLength(2);
    expect(result.items[1].matched).toBe(false);
    expect(result.items[1].kcal).toBeNull();
  });

  it("empty dish list yields zero totals, no crash", () => {
    const result = groundDishes([]);
    expect(result.totals.kcal).toBe(0);
    expect(result.matchedCount).toBe(0);
  });
});

describe("extra nutrients (全栄養素) — fiber / sugar / sodium / saturated", () => {
  it("a db food carries DB-sourced fiber/sugar/sodium (scaled), saturated always null", () => {
    const item = groundDish({ name: "ごはん", grams: 100, source: "db" });
    expect(item.sourceKind).toBe("db");
    // cooked white rice (01088) per 100g: fiber 1.5, sugar 38.1, sodium 1.
    expect(item.fiber_g).toBeCloseTo(1.5, 1);
    expect(item.sugar_g).toBeCloseTo(38.1, 1);
    expect(item.sodium_mg).toBeCloseTo(1, 1);
    // Saturated fat is not in the bundled table → null for a 公式DB item (honest).
    expect(item.saturated_fat_g).toBeNull();
  });

  it("a label/estimate item carries the model's extra nutrients when supplied", () => {
    const item = groundDish({
      name: "プロテインバー",
      grams: 50,
      source: "label",
      kcal: 200,
      protein_g: 20,
      fat_g: 6,
      carb_g: 20,
      fiber_g: 5,
      sugar_g: 8,
      sodium_mg: 150,
      saturated_fat_g: 3,
    });
    expect(item.fiber_g).toBe(5);
    expect(item.sugar_g).toBe(8);
    expect(item.sodium_mg).toBe(150);
    expect(item.saturated_fat_g).toBe(3);
  });

  it("a label/estimate item with NO extra nutrients keeps them null (no fabricated 0)", () => {
    const item = groundDish({
      name: "謎の総菜",
      grams: 100,
      source: "estimate",
      kcal: 250,
      protein_g: 10,
      fat_g: 12,
      carb_g: 22,
    });
    expect(item.kcal).toBe(250); // kcal/PFC present
    expect(item.fiber_g).toBeNull(); // extras unknown → null, NOT 0
    expect(item.sugar_g).toBeNull();
    expect(item.sodium_mg).toBeNull();
    expect(item.saturated_fat_g).toBeNull();
  });

  it("totals sum extras only over items that carry them; null when none do", () => {
    const result = groundDishes([
      { name: "ごはん", grams: 100, source: "db" }, // fiber 1.5, no saturated
      {
        name: "プロテインバー",
        grams: 50,
        source: "label",
        kcal: 200,
        protein_g: 20,
        fat_g: 6,
        carb_g: 20,
        fiber_g: 5,
        saturated_fat_g: 3,
      },
    ]);
    // fiber present on both → summed.
    expect(result.totals.fiber_g).toBeCloseTo(6.5, 1); // 1.5 + 5
    // saturated only on the label item → its value (rice contributes null).
    expect(result.totals.saturated_fat_g).toBe(3);
  });

  it("totals.fiber is null when NO numbered item has a fiber figure", () => {
    const result = groundDishes([
      { name: "謎A", grams: 100, source: "estimate", kcal: 100 },
      { name: "謎B", grams: 100, source: "estimate", kcal: 100 },
    ]);
    expect(result.totals.kcal).toBe(200);
    expect(result.totals.fiber_g).toBeNull(); // honest: no fiber data at all
  });

  it("drops an absurd extra nutrient to null without voiding the whole estimate", () => {
    const item = groundDish({
      name: "誇張バー",
      grams: 50,
      source: "estimate",
      kcal: 200,
      protein_g: 10,
      fiber_g: 9999, // impossible (> portion grams) → dropped to null
    });
    expect(item.kcal).toBe(200); // estimate survives
    expect(item.fiber_g).toBeNull(); // the absurd extra is dropped, not the item
  });
});

describe("3-tier sourced analysis — db / label / estimate", () => {
  it("db food: standard whole food → 公式DB, authoritative, high confidence", () => {
    const item = groundDish({ name: "ごはん", grams: 150, source: "db", confidence: "low" });
    expect(item.matched).toBe(true);
    expect(item.sourceKind).toBe("db");
    expect(item.sourceLabel).toBe("公式DB");
    expect(item.estimated).toBe(false);
    expect(item.kcal).toBe(234); // DB-grounded, not model-supplied
    expect(item.source).toBe(NUTRITION_SOURCE);
    expect(item.confidence).toBe("high"); // DB authority, NOT the model's "low"
  });

  it("db food IGNORES any model kcal/PFC (DB overrides for standard foods)", () => {
    const item = groundDish({
      name: "ごはん",
      grams: 100,
      source: "db",
      kcal: 9999,
      protein_g: 9999,
      fat_g: 9999,
      carb_g: 9999,
    });
    expect(item.kcal).toBe(156); // DB per-100g, NOT 9999
    expect(item.sourceKind).toBe("db");
    expect(item.estimated).toBe(false);
  });

  it("label: packaged product with a readable label → ラベル値, medium, model numbers used", () => {
    const item = groundDish({
      name: "ホエイプロテイン",
      grams: 30,
      source: "label",
      kcal: 120,
      protein_g: 24,
      fat_g: 1.5,
      carb_g: 2,
    });
    expect(item.matched).toBe(false); // not a DB match
    expect(item.sourceKind).toBe("label");
    expect(item.sourceLabel).toBe("ラベル値");
    expect(item.estimated).toBe(true);
    expect(item.kcal).toBe(120); // transcribed label value
    expect(item.protein_g).toBe(24);
    expect(item.source).toBe(SOURCE_LABEL.label);
    expect(item.confidence).toBe("medium");
  });

  it("estimate: not in DB, no label → 推定値, low, marked estimated", () => {
    const item = groundDish({
      name: "コンビニのサラダチキン",
      grams: 110,
      source: "estimate",
      kcal: 115,
      protein_g: 24,
      fat_g: 1.5,
      carb_g: 0.5,
    });
    expect(item.matched).toBe(false);
    expect(item.sourceKind).toBe("estimate");
    expect(item.sourceLabel).toBe("推定値");
    expect(item.estimated).toBe(true);
    expect(item.kcal).toBe(115);
    expect(item.source).toBe(SOURCE_LABEL.estimate);
    expect(item.confidence).toBe("low");
  });

  it("unmatched db food FALLS BACK to the model estimate (no more dead-end)", () => {
    // A "db"-tagged food the DB can't match, but the model supplied an estimate
    // → we surface it as 推定値 instead of "推定できませんでした".
    const item = groundDish({
      name: "オートミールクッキー",
      grams: 40,
      source: "db",
      kcal: 180,
      protein_g: 3,
      fat_g: 8,
      carb_g: 24,
    });
    expect(item.matched).toBe(false);
    expect(item.sourceKind).toBe("estimate");
    expect(item.estimated).toBe(true);
    expect(item.kcal).toBe(180);
    expect(item.confidence).toBe("low");
  });

  it("unmatched db food with NO model numbers → honest no-data", () => {
    const item = groundDish({ name: "架空のごちそうXYZ", grams: 200, source: "db" });
    expect(item.matched).toBe(false);
    expect(item.kcal).toBeNull();
    expect(item.sourceKind).toBeNull();
    expect(item.sourceLabel).toBeNull();
    expect(item.estimated).toBe(false);
  });
});

describe("ANTI-ABSURD-VALUE GUARD — reject negative/impossible model numbers", () => {
  it("rejects an absurd kcal (> MAX_ITEM_KCAL) → honest no-data, never shown", () => {
    const item = groundDish({
      name: "なぞの一品",
      grams: 100,
      source: "estimate",
      kcal: MAX_ITEM_KCAL + 1,
    });
    expect(item.kcal).toBeNull();
    expect(item.sourceKind).toBeNull();
    expect(item.estimated).toBe(false);
  });

  it("rejects a negative kcal → honest no-data", () => {
    const item = groundDish({ name: "なぞ", grams: 50, source: "label", kcal: -10 });
    expect(item.kcal).toBeNull();
    expect(item.sourceKind).toBeNull();
  });

  it("rejects physically impossible macro density (more macro grams than food grams)", () => {
    const item = groundDish({
      name: "なぞ",
      grams: 10,
      source: "estimate",
      kcal: 100,
      protein_g: 50, // 50g protein in a 10g food is impossible
    });
    expect(item.kcal).toBeNull();
    expect(item.sourceKind).toBeNull();
  });

  it("a label item with NO numbers at all → honest no-data (not a fake zero)", () => {
    const item = groundDish({ name: "ラベルが読めない袋", grams: 30, source: "label" });
    expect(item.kcal).toBeNull();
    expect(item.sourceKind).toBeNull();
    expect(item.estimated).toBe(false);
  });
});

describe("ANTI-FABRICATION — an unmeasured PFC stays null (NOT a fabricated 0)", () => {
  it("a kcal-only estimate keeps PFC null (no 0g protein/fat/carb invented)", () => {
    // The model gave only a kcal figure (it couldn't read the macros). Each
    // missing macro must stay null — the UI then shows "—", not a fake 0g.
    const item = groundDish({ name: "屋台のたい焼き", grams: 100, source: "estimate", kcal: 210 });
    expect(item.kcal).toBe(210);
    expect(item.sourceKind).toBe("estimate");
    expect(item.protein_g).toBeNull();
    expect(item.fat_g).toBeNull();
    expect(item.carb_g).toBeNull();
  });

  it("a label item with only kcal + protein keeps the missing fat/carb null", () => {
    const item = groundDish({
      name: "プロテインバー",
      grams: 40,
      source: "label",
      kcal: 150,
      protein_g: 15,
      // fat_g / carb_g omitted — must NOT become 0.
    });
    expect(item.protein_g).toBe(15);
    expect(item.fat_g).toBeNull();
    expect(item.carb_g).toBeNull();
  });

  it("groundDishes totals sum PFC only over items that have them (no 0 from kcal-only)", () => {
    // One estimate carries kcal + protein; another carries kcal only. The protein
    // total must be JUST the first item's protein (the kcal-only item must not add
    // a fabricated 0), and fat/carb must be null (no numbered item carried them).
    const result = groundDishes([
      { name: "焼き菓子A", grams: 100, source: "estimate", kcal: 200, protein_g: 5 },
      { name: "焼き菓子B", grams: 100, source: "estimate", kcal: 150 }, // kcal only
    ]);
    expect(result.numberedCount).toBe(2);
    expect(result.totals.kcal).toBe(350);
    expect(result.totals.protein_g).toBe(5); // only item A's protein, NOT 5+0
    expect(result.totals.fat_g).toBeNull(); // no item carried fat → "—", not 0
    expect(result.totals.carb_g).toBeNull();
  });

  it("a meal of ONLY kcal-only estimates reports PFC totals as null (not 0)", () => {
    const result = groundDishes([
      { name: "謎A", grams: 100, source: "estimate", kcal: 120 },
      { name: "謎B", grams: 100, source: "estimate", kcal: 80 },
    ]);
    expect(result.totals.kcal).toBe(200);
    expect(result.totals.protein_g).toBeNull();
    expect(result.totals.fat_g).toBeNull();
    expect(result.totals.carb_g).toBeNull();
  });

  it("a db food still carries real PFC totals (the null rule never hides DB numbers)", () => {
    const result = groundDishes([{ name: "ごはん", grams: 100, source: "db" }]);
    expect(result.totals.kcal).toBe(156);
    expect(result.totals.protein_g).toBeCloseTo(2.5, 1);
    expect(result.totals.fat_g).toBeCloseTo(0.3, 1);
    expect(result.totals.carb_g).toBeCloseTo(37.1, 1);
  });
});

describe("groundDishes — mixed sources total ALL numbered items + flag estimates", () => {
  it("totals db + label + estimate; flags totalsIncludeEstimate", () => {
    const result = groundDishes([
      { name: "ごはん", grams: 150, source: "db" }, // 234 kcal (DB)
      { name: "プロテイン", grams: 30, source: "label", kcal: 120, protein_g: 24 }, // label
      { name: "外食の唐揚げ", grams: 100, source: "estimate", kcal: 290, protein_g: 16 }, // estimate
    ]);
    expect(result.matchedCount).toBe(1); // only the db food matched
    expect(result.numberedCount).toBe(3); // all three produced a number
    expect(result.totalsIncludeEstimate).toBe(true);
    expect(result.totals.kcal).toBe(234 + 120 + 290);
  });

  it("an all-db meal does NOT flag estimates", () => {
    const result = groundDishes([
      { name: "ごはん", grams: 150, source: "db" },
      { name: "卵", grams: 50, source: "db" },
    ]);
    expect(result.totalsIncludeEstimate).toBe(false);
    expect(result.numberedCount).toBe(2);
    expect(result.matchedCount).toBe(2);
  });

  it("rejected absurd values do not contaminate the total", () => {
    const result = groundDishes([
      { name: "ごはん", grams: 150, source: "db" }, // 234
      { name: "なぞ", grams: 100, source: "estimate", kcal: 999999 }, // rejected
    ]);
    expect(result.numberedCount).toBe(1);
    expect(result.totals.kcal).toBe(234);
    expect(result.totalsIncludeEstimate).toBe(false);
  });
});

describe("bundled lookup integrity", () => {
  it("has the full ~2538 MEXT entries", () => {
    expect(ENTRY_COUNT).toBe(2538);
  });
});

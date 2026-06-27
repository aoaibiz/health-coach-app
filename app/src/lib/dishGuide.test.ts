import { describe, it, expect } from "vitest";
import {
  dishGuideFor,
  dishGuideForOrDefault,
  dishGuideForMeal,
  DEFAULT_GUIDE,
  DEFAULT_GUIDE_SLUG,
  DISH_GUIDE_DIR,
  DISH_GUIDE_SLUGS,
} from "./dishGuide";

describe("dishGuideFor — name → dish image", () => {
  it("matches the canonical staple dishes to their slug", () => {
    expect(dishGuideFor("ごはん")?.slug).toBe("rice");
    expect(dishGuideFor("親子丼")?.slug).toBe("oyakodon");
    expect(dishGuideFor("牛丼")?.slug).toBe("gyudon");
    expect(dishGuideFor("カレーライス")?.slug).toBe("curry-rice");
    expect(dishGuideFor("チャーハン")?.slug).toBe("chahan");
    expect(dishGuideFor("ラーメン")?.slug).toBe("ramen");
    expect(dishGuideFor("うどん")?.slug).toBe("udon");
    expect(dishGuideFor("味噌汁")?.slug).toBe("miso-soup");
    expect(dishGuideFor("焼き魚")?.slug).toBe("grilled-fish");
    expect(dishGuideFor("唐揚げ")?.slug).toBe("chicken-dish");
    expect(dishGuideFor("卵焼き")?.slug).toBe("egg-dish");
    expect(dishGuideFor("サラダ")?.slug).toBe("salad");
    expect(dishGuideFor("ヨーグルト")?.slug).toBe("yogurt");
    expect(dishGuideFor("果物")?.slug).toBe("fruit");
    expect(dishGuideFor("焼き芋")?.slug).toBe("baked-sweet-potato");
    expect(dishGuideFor("パン")?.slug).toBe("bread");
    expect(dishGuideFor("パスタ")?.slug).toBe("pasta");
    expect(dishGuideFor("納豆")?.slug).toBe("natto");
    expect(dishGuideFor("おにぎり")?.slug).toBe("onigiri");
  });

  it("maps common drinks/items to their OWN image (no 定食 fallback for a drink)", () => {
    // Ao feedback ①: a beverage must NEVER show a food/定食 picture.
    expect(dishGuideFor("ブラックコーヒー")?.slug).toBe("coffee");
    expect(dishGuideFor("コーヒー")?.slug).toBe("coffee");
    expect(dishGuideFor("プロテイン")?.slug).toBe("protein-shake");
    expect(dishGuideFor("牛乳")?.slug).toBe("milk");
    expect(dishGuideFor("お茶")?.slug).toBe("tea");
    expect(dishGuideFor("緑茶")?.slug).toBe("tea");
    expect(dishGuideFor("水")?.slug).toBe("water");
    expect(dishGuideFor("ジュース")?.slug).toBe("juice");
    expect(dishGuideFor("オレンジジュース")?.slug).toBe("juice");
    // None of these resolve to the generic default.
    for (const drink of ["ブラックコーヒー", "プロテイン", "牛乳", "お茶", "水", "ジュース"]) {
      expect(dishGuideFor(drink)?.isDefault).toBeFalsy();
    }
  });

  it("absorbs 表記揺れ of drinks/items (variants → same image)", () => {
    expect(dishGuideFor("珈琲")?.slug).toBe("coffee");
    expect(dishGuideFor("アイスコーヒー")?.slug).toBe("coffee");
    expect(dishGuideFor("ホエイプロテイン")?.slug).toBe("protein-shake");
    expect(dishGuideFor("ミルク")?.slug).toBe("milk");
    expect(dishGuideFor("カフェラテ")?.slug).toBe("milk"); // milk-based → milk
    expect(dishGuideFor("麦茶")?.slug).toBe("tea");
    expect(dishGuideFor("紅茶")?.slug).toBe("tea");
    expect(dishGuideFor("ミネラルウォーター")?.slug).toBe("water");
    expect(dishGuideFor("炭酸水")?.slug).toBe("water");
    expect(dishGuideFor("おむすび")?.slug).toBe("onigiri");
    expect(dishGuideFor("握り飯")?.slug).toBe("onigiri");
  });

  it("is case-insensitive and matches English names", () => {
    expect(dishGuideFor("RICE")?.slug).toBe("rice");
    expect(dishGuideFor("Ramen")?.slug).toBe("ramen");
    expect(dishGuideFor("Miso Soup")?.slug).toBe("miso-soup");
    expect(dishGuideFor("salad")?.slug).toBe("salad");
    expect(dishGuideFor("Curry")?.slug).toBe("curry-rice");
  });

  it("absorbs 表記揺れ (writing variants) of the same dish", () => {
    // ご飯 / 白米 / ライス all map to plain rice.
    expect(dishGuideFor("ご飯")?.slug).toBe("rice");
    expect(dishGuideFor("白米")?.slug).toBe("rice");
    expect(dishGuideFor("ライス")?.slug).toBe("rice");
    // からあげ / から揚げ / karaage all map to the chicken dish.
    expect(dishGuideFor("からあげ")?.slug).toBe("chicken-dish");
    expect(dishGuideFor("から揚げ")?.slug).toBe("chicken-dish");
    expect(dishGuideFor("karaage")?.slug).toBe("chicken-dish");
    // みそ汁 / みそしる variants map to miso soup.
    expect(dishGuideFor("みそ汁")?.slug).toBe("miso-soup");
    // 炒飯 / 焼き飯 variants map to chahan.
    expect(dishGuideFor("炒飯")?.slug).toBe("chahan");
    expect(dishGuideFor("焼き飯")?.slug).toBe("chahan");
  });

  it("resolves compound / specific names to the most-specific dish (ordering)", () => {
    // 親子丼 → oyakodon, NOT the bare 丼/ごはん rice row (specific wins).
    expect(dishGuideFor("特製親子丼")?.slug).toBe("oyakodon");
    // チャーハン → chahan, NOT plain rice (米/ごはん is last).
    expect(dishGuideFor("五目チャーハン")?.slug).toBe("chahan");
    // カレーライス → curry-rice, NOT plain rice.
    expect(dishGuideFor("ビーフカレーライス")?.slug).toBe("curry-rice");
    // 牛丼 → gyudon, NOT plain rice.
    expect(dishGuideFor("大盛り牛丼")?.slug).toBe("gyudon");
    // ナポリタン (a pasta) → pasta.
    expect(dishGuideFor("ナポリタン")?.slug).toBe("pasta");
    // 豚汁 → miso-soup family (a miso-based soup).
    expect(dishGuideFor("豚汁")?.slug).toBe("miso-soup");
    // 焼き芋/さつまいも → sweet potato image, NOT the generic placeholder.
    expect(dishGuideFor("焼きさつまいも")?.slug).toBe("baked-sweet-potato");
    expect(dishGuideFor("焼き芋")?.slug).toBe("baked-sweet-potato");
    expect(dishGuideFor("さつまいも")?.slug).toBe("baked-sweet-potato");
    // おにぎり → onigiri (its own image), NOT the bare rice 茶碗 row.
    expect(dishGuideFor("鮭おにぎり")?.slug).toBe("onigiri");
    // 焼きおにぎり still hits onigiri (おにぎり before bare 米/ごはん).
    expect(dishGuideFor("焼きおにぎり")?.slug).toBe("onigiri");
    // plain rice still resolves to rice (drinks/onigiri don't steal it).
    expect(dishGuideFor("白いごはん")?.slug).toBe("rice");
    // a drink does NOT collapse into the rice row even though both are common.
    expect(dishGuideFor("コーヒー")?.slug).not.toBe("rice");
  });

  it("returns a full src path under the public dish-guides dir", () => {
    const g = dishGuideFor("ラーメン");
    expect(g?.src).toBe(`${DISH_GUIDE_DIR}/ramen.png`);
    expect(g?.label).toBe("ラーメン");
  });

  it("GRACEFUL FALLBACK: unknown / empty names return null (no guessed image)", () => {
    expect(dishGuideFor("謎の料理")).toBeNull();
    expect(dishGuideFor("")).toBeNull();
    expect(dishGuideFor("   ")).toBeNull();
    // @ts-expect-error — defensive: a null name must not throw.
    expect(dishGuideFor(null)).toBeNull();
    // @ts-expect-error — defensive: an undefined name must not throw.
    expect(dishGuideFor(undefined)).toBeNull();
  });

  it("every exposed slug resolves to a unique, kebab-case basename", () => {
    const slugs = [...DISH_GUIDE_SLUGS];
    expect(slugs.length).toBeGreaterThanOrEqual(24);
    expect(new Set(slugs).size).toBe(slugs.length); // no duplicates
    for (const s of slugs) expect(s).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("dishGuideForOrDefault — always show SOME image", () => {
  it("returns the specific image when the dish is known", () => {
    expect(dishGuideForOrDefault("親子丼")?.slug).toBe("oyakodon");
    expect(dishGuideForOrDefault("ラーメン")?.slug).toBe("ramen");
    // a known specific match is NOT flagged as the default fallback.
    expect(dishGuideForOrDefault("親子丼")?.isDefault).toBeFalsy();
  });

  it("falls back to the generic default image for an UNKNOWN dish (no gap)", () => {
    const g = dishGuideForOrDefault("謎の料理");
    expect(g?.slug).toBe(DEFAULT_GUIDE_SLUG);
    expect(g?.isDefault).toBe(true);
    expect(g?.src).toBe(`${DISH_GUIDE_DIR}/${DEFAULT_GUIDE_SLUG}.png`);
  });

  it("still returns null for an empty / whitespace / nullish name", () => {
    expect(dishGuideForOrDefault("")).toBeNull();
    expect(dishGuideForOrDefault("   ")).toBeNull();
    // @ts-expect-error — defensive.
    expect(dishGuideForOrDefault(null)).toBeNull();
    // @ts-expect-error — defensive.
    expect(dishGuideForOrDefault(undefined)).toBeNull();
  });

  it("DEFAULT_GUIDE is a well-formed guide pointing at the default PNG", () => {
    expect(DEFAULT_GUIDE.slug).toBe(DEFAULT_GUIDE_SLUG);
    expect(DEFAULT_GUIDE.isDefault).toBe(true);
    expect(DEFAULT_GUIDE.src).toBe(`${DISH_GUIDE_DIR}/${DEFAULT_GUIDE_SLUG}.png`);
    expect(DEFAULT_GUIDE.slug).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("dishGuideForMeal — ONE best image per whole meal", () => {
  it("prefers the meal's own name/text when it names a dish", () => {
    const g = dishGuideForMeal({
      text: "親子丼",
      itemNames: ["ごはん", "鶏肉", "卵"],
    });
    expect(g?.slug).toBe("oyakodon"); // the meal name wins over its items
  });

  it("falls back to the MOST-SPECIFIC recognised item when text doesn't match", () => {
    // text is generic; among items, 唐揚げ (chicken) is more specific than ごはん,
    // so the main dish wins regardless of item order.
    const g = dishGuideForMeal({
      text: "今日のお昼",
      itemNames: ["ごはん", "唐揚げ", "サラダ"],
    });
    expect(g?.slug).toBe("chicken-dish");
  });

  it("lets a real food item override weak drink/supplement whole-meal text", () => {
    expect(dishGuideForMeal({ text: "ブラックコーヒー付き", itemNames: ["トースト"] })?.slug).toBe("bread");
    expect(dishGuideForMeal({ text: "プロテイン朝食", itemNames: ["ヨーグルト"] })?.slug).toBe("yogurt");
  });

  it("prefers a real food item over a weak drink/supplement side item", () => {
    expect(dishGuideForMeal({ text: "朝食", itemNames: ["トースト", "ブラックコーヒー"] })?.slug).toBe(
      "bread",
    );
    expect(dishGuideForMeal({ text: "朝食", itemNames: ["ヨーグルト", "プロテイン"] })?.slug).toBe(
      "yogurt",
    );
  });

  it("does not let a drink side override a specific meal text", () => {
    expect(dishGuideForMeal({ text: "親子丼", itemNames: ["ブラックコーヒー"] })?.slug).toBe("oyakodon");
    expect(dishGuideForMeal({ text: "唐揚げ定食", itemNames: ["お茶"] })?.slug).toBe("chicken-dish");
  });

  it("returns null when text AND items are present but unrecognised", () => {
    const g = dishGuideForMeal({
      text: "謎のごちそう",
      itemNames: ["謎の食材", "謎のソース"],
    });
    expect(g).toBeNull();
  });

  it("resolves from items alone when there is no meal text", () => {
    const g = dishGuideForMeal({ text: "", itemNames: ["味噌汁"] });
    expect(g?.slug).toBe("miso-soup");
  });

  it("resolves from text alone when there are no items", () => {
    expect(dishGuideForMeal({ text: "ラーメン" })?.slug).toBe("ramen");
    expect(dishGuideForMeal({ text: "ラーメン", itemNames: [] })?.slug).toBe("ramen");
    expect(dishGuideForMeal({ text: "ラーメン", itemNames: null })?.slug).toBe("ramen");
  });

  it("returns null when there is nothing at all to illustrate", () => {
    expect(dishGuideForMeal({})).toBeNull();
    expect(dishGuideForMeal({ text: "", itemNames: [] })).toBeNull();
    expect(dishGuideForMeal({ text: "   ", itemNames: ["  ", ""] })).toBeNull();
    expect(dishGuideForMeal({ text: null, itemNames: null })).toBeNull();
  });

  it("ignores blank/nullish item names without throwing", () => {
    const g = dishGuideForMeal({
      text: "",
      itemNames: [null, "  ", undefined, "サラダ", ""],
    });
    expect(g?.slug).toBe("salad");
  });

  it("does not show a generic restaurant-plate placeholder for unmatched meal text", () => {
    // There IS something to illustrate, but no specific static guide. Let the
    // meal page offer image generation instead of showing a misleading plate.
    expect(dishGuideForMeal({ text: "なにかのおかず" })).toBeNull();
  });

  it("maps 焼き芋/さつまいも meals to the dedicated sweet-potato image", () => {
    expect(dishGuideForMeal({ text: "焼きさつまいも" })?.slug).toBe("baked-sweet-potato");
    expect(dishGuideForMeal({ text: "焼き芋" })?.slug).toBe("baked-sweet-potato");
    expect(dishGuideForMeal({ text: "さつまいも", itemNames: ["焼き芋"] })?.slug).toBe(
      "baked-sweet-potato",
    );
  });
});

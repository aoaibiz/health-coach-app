// Dish image-guide lookup (AIプランナー 第3陣D2) — map a food/dish name to an
// appetising illustration ("what it looks like") + its canonical label, so the
// 食事カード can show a tasty thumbnail next to the 品目/kcal/PFC summary. The
// meal-side twin of exerciseGuide.ts.
//
// Pure + testable: a substring keyword match on the name, ordered MOST-SPECIFIC
// FIRST so a compound name resolves to its primary dish. No DOM, no storage.
//
// IMPORTANT — THESE ARE IMAGE FIGURES, NOT DATA. The picture is an「イメージ図」for
// DISPLAY only. It NEVER changes a meal's recorded nutrition, items, or anything
// else — this module maps a name → a slug and nothing more.
//
// FALLBACK (the core contract, same as exerciseGuide):
//   • `dishGuideFor(name)` → the matched specific dish, or `null` (for callers
//     that want "specific-or-nothing", e.g. tests).
//   • `dishGuideForOrDefault(name)` → the matched specific dish, or the GENERIC
//     "お食事" image (DEFAULT_GUIDE) so a meal ALWAYS shows SOME illustration
//     (Ao's no-image-gap rule). Empty names still return `null`.
//   • `dishGuideForMeal({ text, itemNames })` → the best SPECIFIC image for a
//     WHOLE meal: try the meal's own name/text first, else the most-specific
//     match among its items. Unknown foods return null so the card can offer the
//     Codex subscription image-generation path instead of showing a misleading
//     generic plate (Ao feedback: 焼き芋 must not look like a restaurant place
//     setting). The <img> onError still hides a missing PNG, so the feature stays
//     additive and never breaks a card.

/** Public directory the dish PNGs live in (static export → served from root). */
export const DISH_GUIDE_DIR = "/dish-guides";

/** A matched dish image guide. */
export interface DishGuide {
  /** Stable slug = the PNG basename in DISH_GUIDE_DIR (e.g. "ramen"). */
  slug: string;
  /** Absolute public path to the PNG (e.g. "/dish-guides/ramen.png"). */
  src: string;
  /** Canonical Japanese label for the dish (alt text + caption). */
  label: string;
  /** True when this is the generic fallback image, not a dish-specific one. */
  isDefault?: boolean;
}

/** Slug of the generic "any meal" fallback image (always show one). */
export const DEFAULT_GUIDE_SLUG = "dish-default";

/** The generic fallback image shown for meals with no specific illustration. */
export const DEFAULT_GUIDE: DishGuide = {
  slug: DEFAULT_GUIDE_SLUG,
  src: `${DISH_GUIDE_DIR}/${DEFAULT_GUIDE_SLUG}.png`,
  label: "お食事",
  isDefault: true,
};

/**
 * Keyword → dish table. Substring match against the lowercased name, JP or EN.
 * Ordered MOST-SPECIFIC FIRST so a compound name resolves to its primary dish
 * (e.g. "親子丼" hits oyakodon before the bare 丼/ごはん rows; "チャーハン" hits
 * chahan before 米/ごはん). The first matching row wins — same discipline as
 * exerciseGuide.ts's GUIDE_TABLE.
 *
 * Each slug MUST have a matching PNG in public/dish-guides/<slug>.png. A row with
 * no asset on disk simply renders the fallback (the <img> onError hides it), so
 * the table and the assets can be extended independently without breakage.
 */
const GUIDE_TABLE: Array<{ slug: string; label: string; keywords: string[] }> = [
  // --- 飲み物・軽食 with a STRONG dish-type signal go FIRST so the kind of item
  //     beats an ingredient keyword in a longer row: "オレンジジュース" is a JUICE
  //     (not 果物), "鮭おにぎり" is an ONIGIRI (not 焼き魚), "ブラックコーヒー" is a
  //     drink (never a 定食 — Ao feedback ①). A logged drink/riceball name is an
  //     unambiguous intent, so these sit at the top of the most-specific order. ---
  {
    slug: "protein-shake",
    label: "プロテイン",
    keywords: [
      "プロテイン", "protein", "ホエイ", "whey", "プロテインシェイク",
      "protein shake", "プロテインドリンク",
    ],
  },
  {
    // BEFORE coffee so "カフェオレ/カフェラテ" resolve to a milk-based drink.
    slug: "milk",
    label: "牛乳",
    keywords: ["牛乳", "ぎゅうにゅう", "ミルク", "milk", "カフェオレ", "カフェラテ", "ラテ", "latte"],
  },
  {
    slug: "coffee",
    label: "コーヒー",
    keywords: [
      "ブラックコーヒー", "コーヒー", "こーひー", "珈琲", "coffee", "アイスコーヒー",
      "ホットコーヒー", "エスプレッソ", "espresso", "カフェ", "cafe",
    ],
  },
  {
    // 緑茶/麦茶/ほうじ茶/紅茶 + bare 茶/tea. After coffee so カフェ doesn't steal it.
    slug: "tea",
    label: "お茶",
    keywords: [
      "緑茶", "お茶", "麦茶", "ほうじ茶", "ウーロン茶", "烏龍茶", "紅茶", "煎茶",
      "ティー", "tea", "茶",
    ],
  },
  {
    slug: "juice",
    label: "ジュース",
    keywords: [
      "ジュース", "juice", "オレンジジュース", "野菜ジュース", "スムージー", "smoothie",
    ],
  },
  {
    // Bare 水/water LAST among drinks (very generic) but still above food rows.
    slug: "water",
    label: "水",
    keywords: ["お水", "ミネラルウォーター", "炭酸水", "水", "water"],
  },
  {
    // おにぎり gets its OWN image (nori-wrapped triangle); FIRST so "鮭/梅おにぎり"
    // isn't shown as 焼き魚 / a bare rice 茶碗.
    slug: "onigiri",
    label: "おにぎり",
    keywords: ["おにぎり", "お握り", "おむすび", "握り飯", "にぎりめし", "rice ball", "onigiri"],
  },
  // --- 丼もの・specific rice dishes FIRST (so they win over bare 丼/ごはん/米) ---
  {
    slug: "oyakodon",
    label: "親子丼",
    keywords: ["親子丼", "親子どん", "oyakodon", "oyako don"],
  },
  {
    slug: "gyudon",
    label: "牛丼",
    keywords: ["牛丼", "ぎゅうどん", "gyudon", "gyuudon", "beef bowl", "beef rice bowl"],
  },
  {
    slug: "curry-rice",
    label: "カレーライス",
    keywords: ["カレーライス", "カレー", "curry rice", "curry", "カリー"],
  },
  {
    slug: "chahan",
    label: "チャーハン",
    keywords: [
      "チャーハン", "炒飯", "焼き飯", "焼飯", "やきめし", "fried rice",
      "fried-rice", "chahan", "ピラフ", "pilaf",
    ],
  },
  // --- 麺類 (noodles) — before the generic 米/ごはん rows ---
  {
    slug: "ramen",
    label: "ラーメン",
    keywords: [
      "ラーメン", "らーめん", "拉麺", "ramen", "つけ麺", "tsukemen", "中華そば",
    ],
  },
  {
    slug: "udon",
    label: "うどん",
    keywords: ["うどん", "饂飩", "udon"],
  },
  {
    slug: "pasta",
    label: "パスタ",
    keywords: [
      "パスタ", "スパゲ", "スパゲッティ", "スパゲティ", "pasta", "spaghetti",
      "ペペロンチーノ", "ナポリタン", "カルボナーラ", "ミートソース",
    ],
  },
  // --- 汁物 (soup) — before 味噌/bare rows ---
  {
    slug: "miso-soup",
    label: "味噌汁",
    keywords: [
      "味噌汁", "みそ汁", "みそしる", "味噌スープ", "miso soup", "miso-soup",
      "miso shiru", "豚汁", "とん汁", "けんちん汁",
    ],
  },
  // --- 主菜 (mains) ---
  {
    slug: "grilled-fish",
    label: "焼き魚",
    keywords: [
      "焼き魚", "焼魚", "やきざかな", "grilled fish", "塩焼き", "さんま", "秋刀魚",
      "さば", "鯖", "さけ", "鮭", "ほっけ", "あじの開き", "ぶり",
    ],
  },
  {
    slug: "chicken-dish",
    label: "鶏肉料理",
    keywords: [
      "唐揚げ", "からあげ", "から揚げ", "karaage", "鶏肉", "とり肉", "鶏",
      "チキン", "chicken", "焼き鳥", "焼鳥", "やきとり", "ささみ", "もも肉",
      "むね肉", "手羽",
    ],
  },
  {
    slug: "egg-dish",
    label: "卵料理",
    keywords: [
      "卵焼き", "玉子焼き", "たまご焼き", "だし巻き", "オムレツ", "omelet",
      "omelette", "目玉焼き", "スクランブルエッグ", "ゆで卵", "ゆでたまご",
      "卵料理", "玉子料理", "たまご", "egg", "卵",
    ],
  },
  // --- 副菜・軽食 (sides & lighter) ---
  {
    slug: "natto",
    label: "納豆",
    keywords: ["納豆", "なっとう", "natto"],
  },
  {
    slug: "salad",
    label: "サラダ",
    keywords: ["サラダ", "salad", "野菜サラダ", "グリーンサラダ"],
  },
  {
    slug: "yogurt",
    label: "ヨーグルト",
    keywords: ["ヨーグルト", "yogurt", "yoghurt", "ぎりしゃ", "ギリシャヨーグルト"],
  },
  {
    slug: "fruit",
    label: "果物",
    keywords: [
      "果物", "くだもの", "フルーツ", "fruit", "りんご", "林檎", "apple",
      "バナナ", "banana", "みかん", "オレンジ", "orange", "いちご", "苺",
      "ぶどう", "ブドウ", "葡萄",
    ],
  },
  {
    slug: "baked-sweet-potato",
    label: "焼き芋",
    keywords: [
      "焼き芋", "焼芋", "焼きいも", "やきいも", "ヤキイモ", "焼きさつまいも",
      "焼さつまいも", "さつまいも", "サツマイモ", "さつま芋", "薩摩芋",
      "sweet potato", "baked sweet potato", "roasted sweet potato",
    ],
  },
  {
    slug: "bread",
    label: "パン",
    keywords: [
      "食パン", "トースト", "toast", "パン", "bread", "ロールパン", "クロワッサン",
    ],
  },
  // --- 主食 generic LAST (so a specific 丼/麺/dish above wins over bare ごはん/米) ---
  {
    slug: "rice",
    label: "ごはん",
    keywords: [
      "ごはん", "ご飯", "白米", "白ごはん", "米飯", "ライス", "rice",
      "丼", "どんぶり", "米",
    ],
  },
];

/**
 * Internal: the INDEX of the first GUIDE_TABLE row that matches `name`, or -1.
 * Because GUIDE_TABLE is ordered MOST-SPECIFIC FIRST, a lower index means a
 * more-specific dish — which `dishGuideForMeal` uses to pick the main dish over a
 * plain staple among a meal's items.
 */
function matchRowIndex(name: string): number {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return -1;
  for (let i = 0; i < GUIDE_TABLE.length; i++) {
    if (GUIDE_TABLE[i].keywords.some((k) => n.includes(k.toLowerCase()))) return i;
  }
  return -1;
}

/** Internal: build the public DishGuide for a GUIDE_TABLE row. */
function guideForRow(i: number): DishGuide {
  const row = GUIDE_TABLE[i];
  return { slug: row.slug, src: `${DISH_GUIDE_DIR}/${row.slug}.png`, label: row.label };
}

/**
 * Look up the dish image for a single food/dish name. Returns the matched guide,
 * or `null` when the name is empty/whitespace or doesn't match any known dish (the
 * graceful fallback — caller decides whether to use the default). Pure +
 * case-insensitive, same discipline as exerciseGuideFor.
 */
export function dishGuideFor(name: string): DishGuide | null {
  const i = matchRowIndex(name);
  return i < 0 ? null : guideForRow(i);
}

/**
 * Like {@link dishGuideFor} but NEVER returns null for a real name: falls back to
 * the generic {@link DEFAULT_GUIDE} so every meal shows SOME illustration (no
 * image-gap). Still returns `null` for an empty/whitespace/nullish name. The
 * returned default carries `isDefault: true`; the <img> onError still hides a
 * missing PNG.
 */
export function dishGuideForOrDefault(name: string): DishGuide | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  return dishGuideFor(n) ?? DEFAULT_GUIDE;
}

/**
 * Pick the best dish image for a WHOLE meal (the card uses ONE image per meal, so
 * it stays clean and uncluttered). Resolution order, most-trustworthy first:
 *   1. the meal's own name/text (often the dish name, e.g. "親子丼") — a specific
 *      match here is the most representative of the meal as a whole;
 *   2. the FIRST specific non-weak match among the item names, in table order —
 *      i.e. the most-specific recognised food in the meal (so a meal of [ごはん,
 *      唐揚げ, サラダ] shows the 唐揚げ main, not the bare ごはん or side drink);
 *   3. no fallback image for unknown foods. The meal page can offer the Codex
 *      subscription image-generation button instead; a blank is better than a
 *      wrong restaurant-place-setting image for daily-changing menu names.
 * Returns `null` only when there is nothing at all to illustrate (no text AND no
 * non-empty item names), or when the meal is present but unknown to this specific
 * static guide table.
 *
 * Display only — never reads or changes nutrition.
 */
export function dishGuideForMeal(input: {
  /** The meal's free-text name/description (meal.text). */
  text?: string | null;
  /** The meal's item display names (meal.nutrition.items[].name). */
  itemNames?: ReadonlyArray<string | null | undefined> | null;
}): DishGuide | null {
  const text = (input.text ?? "").trim();
  const itemNames = (input.itemNames ?? [])
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);

  // 1) The meal's own name/text — most representative when it names the dish.
  const fromText = text ? dishGuideFor(text) : null;

  // 2) The most-specific recognised item — INDEPENDENT of item order. GUIDE_TABLE
  //    is most-specific-first, so we pick the item with the LOWEST matching row
  //    index: a 唐揚げ (chicken main) beats a ごはん (plain staple) even when ごはん
  //    is listed first. (Picking the first matching item in input order would
  //    surface a side/staple over the main dish — not what the card wants.)
  const weakTextSlugs = new Set([
    "coffee",
    "tea",
    "water",
    "juice",
    "milk",
    "protein-shake",
  ]);
  let bestIdx = -1;
  let bestWeakIdx = -1;
  for (const item of itemNames) {
    const idx = matchRowIndex(item);
    if (idx < 0) continue;

    const slug = GUIDE_TABLE[idx].slug;
    if (weakTextSlugs.has(slug)) {
      if (bestWeakIdx < 0 || idx < bestWeakIdx) bestWeakIdx = idx;
      continue;
    }

    if (bestIdx < 0 || idx < bestIdx) bestIdx = idx;
  }
  if (bestIdx < 0) bestIdx = bestWeakIdx;

  if (bestIdx >= 0) {
    const fromItem = guideForRow(bestIdx);
    const itemIsWeak = weakTextSlugs.has(fromItem.slug);
    const textIsWeak = !!fromText && weakTextSlugs.has(fromText.slug);
    if (!fromText || (textIsWeak && !itemIsWeak)) return fromItem;
  }
  if (fromText) return fromText;

  // 3) Unknown meal: do not show the generic plate as if it were the food.
  return null;
}

/** All distinct slugs that have a dish image (for asset coverage tests/tooling). */
export const DISH_GUIDE_SLUGS: readonly string[] = GUIDE_TABLE.map((r) => r.slug);

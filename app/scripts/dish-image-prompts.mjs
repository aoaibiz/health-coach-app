// Dish/food appetite-guide image PROMPTS — the source of "looks like THAT dish"
// for the auto-generated meal illustrations (health-app AIプランナー 第3陣D2).
//
// WHY THIS FILE EXISTS
// --------------------
// This is the meal-side twin of scripts/exercise-image-prompts.mjs. The workout
// card shows an accurate figure for each move; the meal card should show an
// appetising, immediately-recognisable illustration of the dish. The trick is the
// same: describe each food's EXACT plating/contents in words and hand that precise
// description to GPT Image 2 (Codex built-in image_gen). One glance must read as
// THAT specific dish (e.g. 親子丼, not a generic bowl of rice).
//
// HOW IT'S USED
// -------------
// `generate-dish-images.mjs` imports DISH_PROMPTS, and for each entry builds
//   `${STYLE_PREFIX} ${prompt}`  and feeds it to image_gen, saving to
//   public/dish-guides/<slug>.png
// The slug MUST match a row in src/lib/dishGuide.ts (or be the DEFAULT slug), so
// the lookup table and the assets stay in lock-step.
//
// IMPORTANT — THESE ARE IMAGE FIGURES, NOT DATA
// ---------------------------------------------
// The picture is an「イメージ図」only. It NEVER changes a meal's recorded nutrition
// or items — dishGuide.ts maps a name → a slug for DISPLAY, nothing else.
//
// EDITING / ADDING A DISH
// -----------------------
// 1. Add a { slug, label, prompt } entry below with an ACCURATE, appetising
//    description of the dish's plating and contents (Japanese reasoning, English
//    prompt — image models follow EN best).
// 2. Add/extend the matching keyword row in src/lib/dishGuide.ts.
// 3. Re-run: `node scripts/generate-dish-images.mjs <slug>` (single) or with no
//    args to (re)generate everything. The script is idempotent + re-runnable.

/**
 * Shared STYLE instruction prepended to every dish so all illustrations look like
 * ONE coherent set: appetising flat / soft-watercolour food illustration, neutral
 * and clean, the food plated in its proper dish/bowl, NO text, viewed from a
 * slightly-above (three-quarter / 俯瞰寄り) angle. Keeping this in ONE place means a
 * style tweak re-skins every dish identically — same discipline as the exercise
 * STYLE_PREFIX.
 */
export const STYLE_PREFIX = [
  "A clean, appetising flat illustration of a single Japanese-home-cooking dish,",
  "drawn in a soft warm watercolour style with gentle shading and a light, fresh",
  "palette that makes the food look delicious. Viewed from a slightly-above",
  "three-quarter angle so the contents of the plate or bowl are clearly visible.",
  "SQUARE 1:1 composition: the plated dish fills the frame edge-to-edge with only",
  "a small uniform margin on all four sides, centered and large — no big empty",
  "top/bottom bands, the food is the dominant subject filling the square evenly.",
  "The food is plated in its proper, appropriate dish or bowl (a bowl for 丼/麺,",
  "a plate for おかず, a 茶碗 for rice, a 椀 for soup), centred on a flat, plain,",
  "pale off-white (#f8fafc) background. No text, no labels,",
  "no numbers, no logos, no hands, no people, no background scenery, no table",
  "clutter — just the single appetising dish, clean and unmistakable. The dish:",
].join(" ");

/**
 * Ordered list of dishes to generate. `slug` is the PNG basename + the slug in
 * dishGuide.ts. `label` is the Japanese caption (for human QC). `prompt` is the
 * appetising, accurate English description appended after STYLE_PREFIX.
 *
 * The first entry (slug "dish-default") is the GENERIC fallback illustration shown
 * for any meal we don't have a specific dish image for (the "no image-gap"
 * guarantee). Everything else is a specific dish.
 */
export const DISH_PROMPTS = [
  // --- GENERIC DEFAULT (shown for unmatched meals so an image always appears) ---
  {
    slug: "dish-default",
    label: "お食事",
    prompt:
      "A NEUTRAL generic placeholder icon for 'a food/meal entry' — it MUST NOT " +
      "look like any specific identifiable dish or drink. Draw a simple, clean, " +
      "EMPTY round white plate seen from a slightly-above angle, with a fork on its " +
      "left and a knife on its right, like a minimal restaurant/menu placeholder " +
      "icon. The plate is plain and empty (no food on it). Soft, light, friendly, " +
      "icon-like and abstract — clearly a generic 'meal' symbol, not a meal photo, " +
      "so it never misleads about what was actually eaten.",
  },

  // --- 主食・丼もの (staples & rice bowls) ---
  {
    slug: "rice",
    label: "ごはん",
    prompt:
      "A single small white ceramic 茶碗 (rice bowl) filled with a fluffy mound of " +
      "freshly-steamed glossy white rice, each grain catching a little light, a " +
      "few wisps of warm steam rising. Plain steamed rice, nothing on top.",
  },
  {
    slug: "oyakodon",
    label: "親子丼",
    prompt:
      "Oyakodon: a deep donburi bowl of white rice topped with tender pieces of " +
      "chicken simmered with soft, just-set fluffy egg in a sweet-savoury soy " +
      "dashi sauce, garnished with bright green mitsuba leaves and a little sliced " +
      "scallion. The half-set golden egg blanketing the chicken is the defining " +
      "feature.",
  },
  {
    slug: "gyudon",
    label: "牛丼",
    prompt:
      "Gyudon (beef bowl): a donburi bowl of white rice generously topped with " +
      "thin slices of beef and translucent onion simmered in a glossy sweet-savoury " +
      "soy sauce, often with a sprinkle of red beni-shoga (pickled ginger) on the " +
      "side. Glistening thin beef and onion over rice is the defining feature.",
  },
  {
    slug: "curry-rice",
    label: "カレーライス",
    prompt:
      "Japanese curry rice: a wide plate with white rice on one half and a thick, " +
      "glossy brown curry sauce ladled over the other half, the curry holding " +
      "chunks of carrot, potato and meat. The clear two-sided rice-and-curry plate " +
      "is the defining feature.",
  },
  {
    slug: "chahan",
    label: "チャーハン",
    prompt:
      "Chahan (Japanese fried rice): a mound of golden stir-fried rice flecked with " +
      "scrambled egg, tiny diced char siu pork, green peas, and chopped scallion, " +
      "served on a round plate, looking glossy and savoury. Separate, lightly-oiled " +
      "fried grains are the defining feature.",
  },
  {
    slug: "bread",
    label: "パン",
    prompt:
      "A couple of slices of soft, fluffy 食パン (Japanese milk bread / shokupan) " +
      "with a golden-brown crust, one slice lightly buttered, on a small plate. " +
      "Plump, pillowy white bread is the defining feature.",
  },
  {
    slug: "udon",
    label: "うどん",
    prompt:
      "Kake udon: a large bowl of thick, smooth, glossy white wheat udon noodles " +
      "in a clear golden dashi broth, topped with sliced green scallion and a piece " +
      "of kamaboko fish cake. Thick chewy white noodles in clear broth are the " +
      "defining feature.",
  },
  {
    slug: "ramen",
    label: "ラーメン",
    prompt:
      "Shoyu ramen: a deep bowl of curly yellow wheat noodles in a rich amber " +
      "soy-based broth, topped with two slices of char siu pork, a halved " +
      "soft-boiled ajitama egg with a jammy yolk, a sheet of nori, menma bamboo " +
      "shoots and chopped green scallion. The loaded toppings on noodles in broth " +
      "are the defining feature.",
  },
  {
    slug: "pasta",
    label: "パスタ",
    prompt:
      "A plate of spaghetti pasta neatly twirled, coated in a glossy tomato sauce, " +
      "topped with a little fresh basil and a dusting of grated cheese. Long " +
      "strands of saucy spaghetti on a round plate are the defining feature.",
  },

  // --- 汁物・主菜 (soup & mains) ---
  {
    slug: "miso-soup",
    label: "味噌汁",
    prompt:
      "Miso soup: a small lacquered wooden 椀 (soup bowl) of warm cloudy miso broth " +
      "with cubes of soft white tofu, floating wakame seaweed, and a few rings of " +
      "green scallion, a little steam rising. The cloudy miso broth with tofu and " +
      "wakame is the defining feature.",
  },
  {
    slug: "grilled-fish",
    label: "焼き魚",
    prompt:
      "Grilled fish (焼き魚): a whole salt-grilled mackerel or saury fillet with " +
      "crisp, lightly-charred golden-brown skin, plated on a rectangular dish with " +
      "a small mound of grated daikon radish and a wedge of lemon. The charred " +
      "grilled skin of a whole fish is the defining feature.",
  },
  {
    slug: "chicken-dish",
    label: "鶏肉料理",
    prompt:
      "Karaage (Japanese fried chicken): a small plate of several pieces of " +
      "golden, crispy deep-fried bite-sized chicken with a crunchy craggy coating, " +
      "a wedge of lemon and a little shredded cabbage on the side. Crispy " +
      "golden-brown chicken nuggets are the defining feature.",
  },
  {
    slug: "egg-dish",
    label: "卵料理",
    prompt:
      "Tamagoyaki (Japanese rolled omelette): a few neat slices of a soft, layered, " +
      "pale-yellow rolled omelette with visible rolled layers, plated with a small " +
      "mound of grated daikon. The layered rolled yellow egg slices are the " +
      "defining feature.",
  },

  // --- 副菜・軽食 (sides & lighter) ---
  {
    slug: "salad",
    label: "サラダ",
    prompt:
      "A fresh green salad in a wide shallow bowl: crisp leafy lettuce, ripe red " +
      "cherry-tomato halves, slices of cucumber and thin red onion, glossy with a " +
      "light dressing. A colourful, crisp, fresh vegetable salad is the defining " +
      "feature.",
  },
  {
    slug: "yogurt",
    label: "ヨーグルト",
    prompt:
      "A small glass bowl of thick, creamy white plain yogurt topped with a few " +
      "fresh blueberries and strawberry slices and a light drizzle of honey. " +
      "Smooth white yogurt with berries on top is the defining feature.",
  },
  {
    slug: "fruit",
    label: "果物",
    prompt:
      "A small plate of assorted cut fresh fruit: a few wedges of orange, slices " +
      "of red apple, and a couple of strawberries, fresh and glistening. A " +
      "colourful little fruit plate is the defining feature.",
  },
  {
    slug: "baked-sweet-potato",
    label: "焼き芋",
    prompt:
      "Yaki-imo (Japanese roasted sweet potato): one whole roasted purple-skinned " +
      "sweet potato split open lengthwise, showing a steaming golden-yellow soft " +
      "flesh inside, with a couple of thick coin slices beside it. It should look " +
      "like a simple warm snack, not a plated restaurant meal. The purple skin and " +
      "golden roasted sweet-potato flesh are the defining features.",
  },
  {
    slug: "natto",
    label: "納豆",
    prompt:
      "Natto: a small bowl of sticky fermented soybeans with their characteristic " +
      "glossy stringy threads, topped with a little chopped green scallion and a " +
      "drizzle of soy sauce. The sticky brown stringy soybeans are the defining " +
      "feature.",
  },
  {
    slug: "onigiri",
    label: "おにぎり",
    prompt:
      "Onigiri (rice ball): one or two plump triangular white rice balls, each " +
      "wrapped at the bottom with a neat strip of dark green nori seaweed, on a " +
      "small plate. The triangular nori-wrapped rice ball shape is the defining " +
      "feature — NOT a bowl of loose rice.",
  },

  // --- 飲み物 (drinks) — common logged beverages get their OWN clear image so a
  //     drink never falls back to a food picture (Ao: no 定食 for ブラックコーヒー). ---
  {
    slug: "coffee",
    label: "コーヒー",
    prompt:
      "A cup of black coffee: a white ceramic coffee cup on a matching saucer, " +
      "filled with dark glossy black coffee, a faint wisp of steam rising, a small " +
      "spoon on the saucer. Plain black coffee, no milk, no foam. The dark coffee " +
      "in a simple white cup is the defining feature.",
  },
  {
    slug: "protein-shake",
    label: "プロテイン",
    prompt:
      "A protein shake: a tall cylindrical protein shaker bottle (or a tall glass) " +
      "filled with a smooth, opaque, creamy off-white/beige protein drink, a few " +
      "light bubbles on top. A clearly muscle/fitness style protein drink in a " +
      "shaker is the defining feature — a thick creamy shake, not coffee or milk.",
  },
  {
    slug: "milk",
    label: "牛乳",
    prompt:
      "A glass of milk: a clear straight drinking glass filled with plain opaque " +
      "white milk, a soft highlight on the glass. Just a glass of fresh white milk " +
      "on the plain background. The pure white milk in a clear glass is the " +
      "defining feature.",
  },
  {
    slug: "tea",
    label: "お茶",
    prompt:
      "A cup of Japanese green tea: a small handle-less ceramic 湯のみ (tea cup) " +
      "filled with clear pale-green hot tea, a faint wisp of steam. Plain green " +
      "tea, no milk. The pale green tea in a simple Japanese tea cup is the " +
      "defining feature.",
  },
  {
    slug: "water",
    label: "水",
    prompt:
      "A glass of water: a clear straight drinking glass filled with clean, " +
      "colourless, transparent water with a couple of small bubbles and a bright " +
      "highlight on the glass. Just plain clear water in a clear glass on the " +
      "plain background. The crystal-clear colourless water is the defining feature.",
  },
  {
    slug: "juice",
    label: "ジュース",
    prompt:
      "A glass of orange juice: a clear straight drinking glass filled with bright, " +
      "vivid orange fruit juice, a thin wedge of orange perched on the rim. The " +
      "bright orange juice in a clear glass is the defining feature — clearly fruit " +
      "juice, not water or milk.",
  },
];

/** Map of slug → entry, for single-slug regeneration lookups. */
export const PROMPTS_BY_SLUG = Object.fromEntries(
  DISH_PROMPTS.map((e) => [e.slug, e]),
);

/** The slug used for the generic "always show something" fallback dish image. */
export const DEFAULT_SLUG = "dish-default";

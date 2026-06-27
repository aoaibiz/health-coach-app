// Exercise figure-guide image PROMPTS — the source of "accuracy" for the
// auto-generated workout illustrations (health-app AIプランナー Phase3).
//
// WHY THIS FILE EXISTS
// --------------------
// The old guides were drawn loosely (a pull-up that's just "arms spread, not
// hanging from a bar"; a Bulgarian split squat that's a plain squat). The fix is
// to describe each move's EXACT body position in words and hand that precise
// description to GPT Image 2 (Codex built-in image_gen). One glance at the result
// must read as THAT specific exercise with correct form.
//
// HOW IT'S USED
// -------------
// `generate-exercise-images.mjs` imports EXERCISE_PROMPTS, and for each entry
// builds: `${STYLE_PREFIX} ${move}` and feeds it to image_gen, saving to
//   public/exercise-guides/<slug>.png
// The slug MUST match a row in src/lib/exerciseGuide.ts (or be the DEFAULT slug),
// so the lookup table and the assets stay in lock-step.
//
// EDITING / ADDING A MOVE
// -----------------------
// 1. Add a { slug, label, prompt } entry below with an ACCURATE side-view form
//    description (Japanese reasoning, English prompt — image models follow EN best).
// 2. Add/extend the matching keyword row in src/lib/exerciseGuide.ts.
// 3. Re-run: `node scripts/generate-exercise-images.mjs <slug>` (single) or with
//    no args to (re)generate everything. The script is idempotent + re-runnable.

/**
 * Shared STYLE instruction prepended to every move so all figures look like one
 * coherent set: simple flat-line illustration, neutral androgynous figure, teal
 * accent, pale background, NO text/labels/numbers, single side-view subject.
 * Keeping this in ONE place means a style tweak re-skins every guide identically.
 */
export const STYLE_PREFIX = [
  "A simple, clean flat-line vector illustration of a single human figure",
  "demonstrating one exercise, drawn as a clear instructional fitness diagram.",
  "SQUARE 1:1 composition: the figure (and any named equipment) fills the frame",
  "edge-to-edge with only a small uniform margin on all four sides, centered — no",
  "large empty top/bottom bands, the subject is large and evenly framed.",
  "Side profile view (unless stated otherwise). Minimal neutral androgynous",
  "person with smooth rounded limbs, drawn with consistent medium-weight dark",
  "outlines and a single teal (#14b8a6) accent color, on a flat pale off-white",
  "(#f8fafc) background. No text, no labels, no numbers, no arrows, no watermark,",
  "no background scenery — just the figure (and the named equipment). Anatomically",
  "correct, balanced proportions, the posture must unmistakably read as the",
  "specific exercise described. The move:",
].join(" ");

/**
 * Ordered list of exercises to generate. `slug` is the PNG basename + the slug in
 * exerciseGuide.ts. `label` is the Japanese caption (for human QC). `prompt` is
 * the ACCURATE English form description appended after STYLE_PREFIX.
 *
 * The first entry (slug "exercise-default") is the GENERIC fallback figure shown
 * for any logged move we don't have a specific figure for (the "no image-gap"
 * guarantee). Everything else is a specific move.
 */
export const EXERCISE_PROMPTS = [
  // --- GENERIC DEFAULT (shown for unmatched moves so a figure always appears) ---
  {
    slug: "exercise-default",
    label: "運動",
    prompt:
      "A neutral generic strength-training pose: the figure stands upright, " +
      "feet shoulder-width apart, holding one dumbbell in each hand down at the " +
      "sides, looking forward, relaxed and ready. A simple universal 'exercise' " +
      "icon-style figure that suits any workout, not any one specific lift.",
  },

  // --- Bodyweight staples ---
  {
    slug: "pull-up",
    label: "懸垂",
    prompt:
      "Pull-up (chin-up). Side view. The figure hangs from a horizontal " +
      "overhead bar gripping it with BOTH hands shoulder-width in an overhand " +
      "grip, ARMS BENT, pulling the body UP so the chin is at the height of the " +
      "bar. The whole body hangs below the bar, legs straight and together " +
      "pointing down (or knees slightly bent), back slightly arched. The defining " +
      "feature is clearly HANGING from and being pulled up to a fixed bar — NOT " +
      "standing, NOT just spreading the arms.",
  },
  {
    slug: "push-up",
    label: "腕立て伏せ",
    prompt:
      "Push-up. Side view. The figure is face-down in a plank-to-press " +
      "position: body held in ONE straight rigid line from head to heels, hands " +
      "flat on the floor directly under the shoulders, elbows bent so the chest " +
      "is lowered close to the floor, toes on the ground. Arms support the body.",
  },
  {
    slug: "plank",
    label: "プランク",
    prompt:
      "Plank (forearm plank). Side view. The figure is face-down holding an " +
      "isometric hold: FOREARMS flat on the floor (elbows under shoulders), body " +
      "held in ONE straight rigid line from head through hips to heels, toes on " +
      "the floor, hips neither sagging nor piked. A static hold, not a movement.",
  },
  {
    slug: "crunch",
    label: "腹筋（クランチ）",
    prompt:
      "Abdominal crunch / sit-up. Side view. The figure lies on its back on the " +
      "floor with KNEES BENT and feet flat, hands lightly behind the head, and " +
      "curls the upper back and shoulders UP off the floor toward the knees, " +
      "contracting the abs. Lower back stays near the floor.",
  },
  {
    slug: "lunge",
    label: "ランジ",
    prompt:
      "Forward lunge. Side view. The figure steps one leg far forward and bends " +
      "BOTH knees to about 90 degrees — front thigh roughly parallel to the floor " +
      "with the front knee over the ankle, the rear knee dropped low toward the " +
      "floor with the rear heel lifted. Torso upright, hands on hips or at sides.",
  },

  // --- Squat family ---
  {
    slug: "squat",
    label: "スクワット",
    prompt:
      "Barbell-free bodyweight squat. Side view. Feet shoulder-width apart, the " +
      "figure sits the hips DOWN and BACK until the thighs are PARALLEL to the " +
      "floor, knees tracking over the toes (not past them), back straight and " +
      "chest up, arms extended forward for balance.",
  },
  {
    slug: "bulgarian-split-squat",
    label: "ブルガリアンスクワット",
    prompt:
      "Bulgarian split squat (rear-foot-elevated split squat). Side view. The " +
      "TOP of the REAR foot rests on a raised bench/box behind the figure, while " +
      "the FRONT leg bends to about 90 degrees, dropping the hips straight down " +
      "until the front thigh is near parallel to the floor and the rear knee " +
      "lowers toward the floor. Upper body stays UPRIGHT and vertical. The " +
      "defining feature is the rear foot elevated on a bench behind — NOT a normal " +
      "two-foot squat.",
  },

  // --- Compound lifts ---
  {
    slug: "deadlift",
    label: "デッドリフト",
    prompt:
      "Barbell deadlift, bottom position. Side view. The figure stands with feet " +
      "hip-width over a barbell on the floor, hinged forward at the HIPS with a " +
      "FLAT straight back at roughly 45 degrees, knees slightly bent, both arms " +
      "straight down gripping the barbell just outside the knees, about to stand " +
      "up. Long horizontal barbell with round plates on each end.",
  },
  {
    slug: "bench-press",
    label: "ベンチプレス",
    prompt:
      "Barbell bench press. Side view. The figure lies on its BACK on a flat " +
      "horizontal bench, feet flat on the floor, holding a horizontal barbell " +
      "with round plates above the chest, elbows bent so the bar is lowered near " +
      "the chest. The bench is clearly horizontal and the lifter is supine.",
  },

  // --- Dumbbell / shoulder moves ---
  {
    slug: "shoulder-press",
    label: "ショルダープレス",
    prompt:
      "Overhead shoulder press (military press). Side view, figure standing " +
      "upright. Holding a dumbbell in each hand pressed straight UP OVERHEAD, " +
      "arms nearly fully extended above the head, the dumbbells above the " +
      "shoulders. Torso vertical, core braced.",
  },
  {
    slug: "lateral-raise",
    label: "サイドレイズ",
    prompt:
      "Dumbbell lateral raise (side raise). FRONT view. The figure stands " +
      "upright holding a dumbbell in each hand, arms raised OUT TO THE SIDES to " +
      "shoulder height forming a 'T' shape, elbows almost straight with a slight " +
      "bend, palms facing down. The defining feature is both arms lifted sideways " +
      "to shoulder level.",
  },
  {
    slug: "dumbbell-press",
    label: "ダンベルプレス",
    prompt:
      "Dumbbell chest press. Side view. The figure lies on its BACK on a flat " +
      "horizontal bench, feet flat on the floor, holding a dumbbell in each hand " +
      "pressed straight UP above the chest with arms nearly extended, elbows " +
      "slightly bent. Supine on a clearly horizontal bench.",
  },
  {
    slug: "dumbbell-curl",
    label: "ダンベルカール",
    prompt:
      "Standing dumbbell biceps curl. Side view. The figure stands upright, " +
      "upper arm fixed at the side, holding a dumbbell and curling it UP toward " +
      "the shoulder by bending the elbow, forearm lifted, biceps contracted, " +
      "palm facing up. Only the forearm moves.",
  },
];

/** Map of slug → entry, for single-slug regeneration lookups. */
export const PROMPTS_BY_SLUG = Object.fromEntries(
  EXERCISE_PROMPTS.map((e) => [e.slug, e]),
);

/** The slug used for the generic "always show something" fallback figure. */
export const DEFAULT_SLUG = "exercise-default";

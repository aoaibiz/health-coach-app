// Exercise figure-guide lookup (AIプランナー Phase3) — map a logged exercise name
// to a clear illustrated figure ("how to do it") + its canonical label, so the
// workout card can show a visual guide next to the「何セット×何回」summary.
//
// Pure + testable: a substring keyword match on the exercise name, mirroring the
// vocabulary already used by burn.ts / muscleGroups.ts so the three stay
// consistent. No DOM, no storage.
//
// FALLBACK (the core contract): we never GUESS a SPECIFIC figure for an unknown
// move (an unrelated illustration misleads). Instead:
//   • `exerciseGuideFor(name)` → the matched specific guide, or `null` (kept for
//     callers that want "specific-or-nothing", e.g. existing tests).
//   • `exerciseGuideForOrDefault(name)` → the matched specific guide, or the
//     GENERIC "exercise" figure (DEFAULT_GUIDE) so a workout move always shows
//     SOME illustration (Ao's "全種目に画像(B)" — no image-gaps). Empty names
//     still return `null`. The <img> onError still hides a missing/broken PNG, so
//     the feature stays additive and never breaks a card.

/** Public directory the figure PNGs live in (static export → served from root). */
export const EXERCISE_GUIDE_DIR = "/exercise-guides";
export const EXERCISE_GUIDE_ASSET_VERSION = "20260626-transparent-bg";

function exerciseGuideSrc(slug: string): string {
  return `${EXERCISE_GUIDE_DIR}/${slug}.png?v=${EXERCISE_GUIDE_ASSET_VERSION}`;
}

/** A matched figure guide for an exercise. */
export interface ExerciseGuide {
  /** Stable slug = the PNG basename in EXERCISE_GUIDE_DIR (e.g. "squat"). */
  slug: string;
  /** Absolute public path to the figure PNG (e.g. "/exercise-guides/squat.png"). */
  src: string;
  /** Canonical Japanese label for the move (alt text + caption). */
  label: string;
  /** True when this is the generic fallback figure, not a move-specific one. */
  isDefault?: boolean;
}

/** Slug of the generic "any exercise" fallback figure (B方針: always show one). */
export const DEFAULT_GUIDE_SLUG = "exercise-default";

/** The generic fallback figure shown for moves with no specific illustration. */
export const DEFAULT_GUIDE: ExerciseGuide = {
  slug: DEFAULT_GUIDE_SLUG,
  src: exerciseGuideSrc(DEFAULT_GUIDE_SLUG),
  label: "運動",
  isDefault: true,
};

/**
 * Keyword → figure table. Substring match against the lowercased name, JP or EN.
 * Ordered MOST-SPECIFIC FIRST so a compound name resolves to its primary figure
 * (e.g. "ダンベルショルダープレス" hits ショルダープレス before the generic
 * プレス/ダンベル rows, "レッグプレス" hits スクワット-family legs, etc.). The
 * first matching row wins — same discipline as muscleGroups.ts's MUSCLE_TABLE.
 *
 * Each slug MUST have a matching PNG in public/exercise-guides/<slug>.png. A row
 * with no asset on disk simply renders the fallback (the <img> onError hides it),
 * so the table and the assets can be extended independently without breakage.
 */
const GUIDE_TABLE: Array<{ slug: string; label: string; keywords: string[] }> = [
  // --- Compound / specific lifts FIRST (so they win over generic keywords) ---
  {
    slug: "deadlift",
    label: "デッドリフト",
    keywords: ["デッドリフト", "deadlift", "デッド"],
  },
  {
    slug: "shoulder-press",
    label: "ショルダープレス",
    keywords: [
      "ショルダープレス", "shoulder press", "オーバーヘッドプレス",
      "overhead press", "ミリタリープレス", "military press", "ショルダー", "shoulder",
    ],
  },
  {
    // Lateral raise BEFORE the generic ダンベル/プレス rows so "サイドレイズ" /
    // "ダンベルサイドレイズ" resolves to its own figure (arms out to a T), not a
    // press/curl.
    slug: "lateral-raise",
    label: "サイドレイズ",
    keywords: [
      "サイドレイズ", "side raise", "ラテラルレイズ", "lateral raise",
      "サイドレイ", "レイズ",
    ],
  },
  {
    slug: "dumbbell-curl",
    label: "ダンベルカール",
    keywords: [
      "ダンベルカール", "dumbbell curl", "アームカール", "arm curl",
      "バイセップカール", "biceps curl", "bicep curl", "カール", "curl",
    ],
  },
  {
    slug: "bench-press",
    label: "ベンチプレス",
    keywords: ["ベンチプレス", "bench press", "ベンチ", "bench", "チェストプレス", "chest press"],
  },
  {
    // Generic dumbbell PRESS (chest/floor press). Comes after bench/shoulder/
    // lateral/curl so those win; catches a bare "ダンベルプレス".
    slug: "dumbbell-press",
    label: "ダンベルプレス",
    keywords: ["ダンベルプレス", "dumbbell press"],
  },
  {
    // Bulgarian split squat BEFORE plain squat so "ブルガリアンスクワット" /
    // "スプリットスクワット" resolves to the rear-foot-elevated figure, not the
    // ordinary two-foot squat (the exact accuracy bug Ao flagged).
    slug: "bulgarian-split-squat",
    label: "ブルガリアンスクワット",
    keywords: [
      "ブルガリアン", "bulgarian", "スプリットスクワット", "split squat",
      "split-squat", "リアフットエレベーテッド", "rear foot elevated",
    ],
  },
  {
    // Lunge gets its OWN figure now (was folded into squat). Before plain squat so
    // "ウォーキングランジ" etc. resolve to the lunge figure.
    slug: "lunge",
    label: "ランジ",
    keywords: ["ランジ", "lunge"],
  },
  {
    slug: "squat",
    label: "スクワット",
    keywords: [
      "スクワット", "squat", "レッグプレス", "leg press",
    ],
  },
  // --- Bodyweight staples ---
  {
    slug: "push-up",
    label: "腕立て伏せ",
    keywords: ["腕立て", "腕立", "プッシュアップ", "push up", "push-up", "pushup"],
  },
  {
    slug: "pull-up",
    label: "懸垂",
    keywords: ["懸垂", "チンニング", "pull up", "pull-up", "pullup", "chin up", "chin-up", "chinup"],
  },
  {
    slug: "plank",
    label: "プランク",
    keywords: ["プランク", "plank"],
  },
  {
    slug: "crunch",
    label: "腹筋（クランチ）",
    keywords: ["腹筋", "クランチ", "crunch", "シットアップ", "sit up", "sit-up", "situp"],
  },
];

/**
 * Look up the figure guide for an exercise name. Returns the matched guide, or
 * `null` when the name is empty/whitespace or doesn't match any known move (the
 * graceful fallback — the card then shows no image, exactly as before).
 * Pure + case-insensitive, mirroring metForExercise / muscleGroupForExercise.
 */
export function exerciseGuideFor(name: string): ExerciseGuide | null {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return null;
  for (const row of GUIDE_TABLE) {
    if (row.keywords.some((k) => n.includes(k.toLowerCase()))) {
      return { slug: row.slug, src: exerciseGuideSrc(row.slug), label: row.label };
    }
  }
  return null;
}

/**
 * Like {@link exerciseGuideFor} but NEVER returns null for a real move name:
 * falls back to the generic {@link DEFAULT_GUIDE} so every logged exercise shows
 * SOME figure (Ao's B方針 — no image-gaps). Still returns `null` for an
 * empty/whitespace/nullish name (nothing to illustrate). The returned default
 * carries `isDefault: true` so callers can style/caption it differently if they
 * wish; the <img> onError fallback still hides a missing PNG.
 */
export function exerciseGuideForOrDefault(name: string): ExerciseGuide | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  return exerciseGuideFor(n) ?? DEFAULT_GUIDE;
}

/** All distinct slugs that have a figure (for asset coverage tests/tooling). */
export const EXERCISE_GUIDE_SLUGS: readonly string[] = GUIDE_TABLE.map((r) => r.slug);

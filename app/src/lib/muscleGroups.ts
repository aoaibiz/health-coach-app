// Muscle-group classification for logged exercises — the foundation for the
// coach's "鍛えた部位 / 鍛えてない部位（空白）" awareness (Ao 2026-06-24: a real
// personal trainer notices you've skipped legs for two weeks and prescribes a
// leg day). Pure + testable: a substring keyword match on the exercise name,
// mirroring the vocabulary already used by burn.ts so the two stay consistent.
//
// HONESTY: an unrecognised name maps to "other" (not a guessed muscle), so the
// coach never claims you trained a body part the data doesn't actually support.

/**
 * The body regions the coach reasons about. "cardio" is the time/distance work
 * (running/cycling/…); "other" is a named exercise we can't confidently place
 * (so it counts as training happened, but not toward a specific muscle gap).
 */
export type MuscleGroup =
  | "chest"
  | "back"
  | "legs"
  | "shoulders"
  | "arms"
  | "core"
  | "cardio"
  | "other";

/** Japanese label for a muscle group (used by the prompt + the history view). */
export const MUSCLE_GROUP_LABEL: Record<MuscleGroup, string> = {
  chest: "胸",
  back: "背中",
  legs: "脚",
  shoulders: "肩",
  arms: "腕",
  core: "腹・体幹",
  cardio: "有酸素",
  other: "その他",
};

/**
 * The "main" trainable muscle groups the coach checks for GAPS (空白). Cardio and
 * "other" are deliberately excluded: skipping cardio isn't a strength gap, and
 * "other" can't be attributed to a specific muscle, so neither should be reported
 * as an untrained muscle. Order = display order (push→pull→legs→…).
 */
export const MAIN_MUSCLE_GROUPS: readonly MuscleGroup[] = [
  "chest",
  "back",
  "legs",
  "shoulders",
  "arms",
  "core",
];

/**
 * Keyword → muscle group table. Substring match against the lowercased name, JP
 * or EN. Ordered MOST-SPECIFIC FIRST so a compound name resolves to its primary
 * mover (e.g. "ダンベルショルダープレス" hits 肩 before the generic プレス→胸,
 * "レッグカール" hits 脚 before カール→腕). The first matching row wins.
 */
const MUSCLE_TABLE: Array<{ group: MuscleGroup; keywords: string[] }> = [
  // Cardio FIRST — these names also look like bodyweight work, but the meaningful
  // metric is time/distance, not a muscle (matches burn.ts CARDIO_KEYWORDS).
  {
    group: "cardio",
    keywords: [
      "ランニング", "running", "run", "ジョギング", "jog",
      "ウォーキング", "walking", "walk", "散歩",
      "サイクリング", "バイク", "cycling", "bike", "自転車",
      "水泳", "swim", "エアロバイク", "縄跳び", "ジャンプロープ", "jump rope",
      "有酸素", "hiit", "サーキット", "circuit", "エリプティカル", "elliptical",
    ],
  },
  // Legs — specific leg moves before the generic curl/press fall-through.
  {
    group: "legs",
    keywords: [
      "スクワット", "squat", "レッグプレス", "leg press", "レッグ", "leg",
      "デッドリフト", "deadlift", "ランジ", "lunge", "カーフ", "calf",
      "ヒップスラスト", "hip thrust", "ブルガリアン", "bulgarian",
      "レッグカール", "leg curl", "レッグエクステンション", "extension",
      "脚", "太もも", "ふくらはぎ", "もも", "下半身",
    ],
  },
  // Back — pulls. デッドリフト already claimed by legs above (posterior-chain
  // primary); the rest of the back pulls live here.
  {
    group: "back",
    keywords: [
      "懸垂", "チンニング", "pull up", "pull-up", "pullup", "chin",
      "ラットプル", "lat pull", "lat", "ラット",
      "ロウ", "row", "ローイング", "rowing",
      "プルダウン", "pulldown", "プルオーバー", "pullover",
      "バックエクステンション", "back extension", "背筋", "背中", "広背筋",
      "シュラッグ", "shrug", "デッド",
    ],
  },
  // Shoulders — before chest press, so ショルダープレス/サイドレイズ hit 肩.
  {
    group: "shoulders",
    keywords: [
      "ショルダー", "shoulder", "サイドレイズ", "side raise", "lateral raise",
      "レイズ", "raise", "フロントレイズ", "リアレイズ", "rear",
      "アップライト", "upright", "オーバーヘッド", "overhead",
      "肩", "三角筋", "デルト", "delt", "ミリタリープレス", "military",
    ],
  },
  // Arms — curls/extensions/biceps/triceps. BEFORE chest so a triceps "プレス
  // ダウン" hits arms instead of the generic chest "プレス" fall-through; the arm
  // keywords are distinctive (トライセプス/バイセップ/カール/キックバック/
  // プレスダウン) and deliberately do NOT include a bare "プレス", so ベンチプレス
  // still falls to chest below. レッグカール already routed to legs above.
  {
    group: "arms",
    keywords: [
      "カール", "curl", "アーム", "arm",
      "トライセプス", "triceps", "tricep", "上腕三頭",
      "バイセップ", "biceps", "bicep", "上腕二頭",
      "キックバック", "kickback", "プレスダウン", "pressdown", "pushdown",
      "リストカール", "wrist", "前腕", "二の腕", "力こぶ",
    ],
  },
  // Chest — press/fly/push. Generic プレス/press falls here last among pushes.
  {
    group: "chest",
    keywords: [
      "ベンチ", "bench", "チェスト", "chest", "ダンベルプレス",
      "フライ", "fly", "flye", "ペック", "pec", "ディップ", "dip",
      "腕立て", "プッシュアップ", "push up", "push-up", "pushup", "腕立",
      "胸", "大胸筋", "プレス", "press",
    ],
  },
  // Core — abs/obliques/plank.
  {
    group: "core",
    keywords: [
      "腹筋", "クランチ", "crunch", "シットアップ", "sit up", "sit-up", "situp",
      "プランク", "plank", "レッグレイズ", "leg raise",
      "ロシアンツイスト", "russian twist", "ツイスト", "twist",
      "アブ", "abs", "腹", "体幹", "オブリーク", "oblique", "ニーレイズ",
    ],
  },
];

/**
 * Classify an exercise name into a muscle group. Unrecognised → "other" (never a
 * guessed muscle). Empty/whitespace → "other". Pure + case-insensitive.
 */
export function muscleGroupForExercise(name: string): MuscleGroup {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return "other";
  for (const row of MUSCLE_TABLE) {
    if (row.keywords.some((k) => n.includes(k.toLowerCase()))) return row.group;
  }
  return "other";
}

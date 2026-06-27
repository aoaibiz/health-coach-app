import { describe, it, expect } from "vitest";
import {
  exerciseGuideFor,
  exerciseGuideForOrDefault,
  DEFAULT_GUIDE,
  DEFAULT_GUIDE_SLUG,
  EXERCISE_GUIDE_ASSET_VERSION,
  EXERCISE_GUIDE_DIR,
  EXERCISE_GUIDE_SLUGS,
} from "./exerciseGuide";

describe("exerciseGuideFor — name → figure guide", () => {
  it("matches the canonical staples to their slug", () => {
    expect(exerciseGuideFor("スクワット")?.slug).toBe("squat");
    expect(exerciseGuideFor("腕立て伏せ")?.slug).toBe("push-up");
    expect(exerciseGuideFor("プランク")?.slug).toBe("plank");
    expect(exerciseGuideFor("腹筋")?.slug).toBe("crunch");
    expect(exerciseGuideFor("ダンベルカール")?.slug).toBe("dumbbell-curl");
    expect(exerciseGuideFor("ショルダープレス")?.slug).toBe("shoulder-press");
    expect(exerciseGuideFor("デッドリフト")?.slug).toBe("deadlift");
    expect(exerciseGuideFor("ベンチプレス")?.slug).toBe("bench-press");
    expect(exerciseGuideFor("懸垂")?.slug).toBe("pull-up");
  });

  it("is case-insensitive and matches English names", () => {
    expect(exerciseGuideFor("SQUAT")?.slug).toBe("squat");
    expect(exerciseGuideFor("Push-up")?.slug).toBe("push-up");
    expect(exerciseGuideFor("Bench Press")?.slug).toBe("bench-press");
    expect(exerciseGuideFor("plank")?.slug).toBe("plank");
  });

  it("resolves compound names to the most-specific figure (ordering)", () => {
    // ダンベルショルダープレス → shoulder-press (not the generic dumbbell-curl/
    // bench-press), proving most-specific-first ordering wins.
    expect(exerciseGuideFor("ダンベルショルダープレス")?.slug).toBe("shoulder-press");
    // レッグプレス → squat-family (leg), not a chest press.
    expect(exerciseGuideFor("レッグプレス")?.slug).toBe("squat");
    // ダンベルカール → dumbbell-curl (curl wins over a bare "ダンベル").
    expect(exerciseGuideFor("ダンベルカール")?.slug).toBe("dumbbell-curl");
    // シットアップ → crunch family (abs).
    expect(exerciseGuideFor("シットアップ")?.slug).toBe("crunch");
    // ランジ → its OWN lunge figure now (no longer folded into squat).
    expect(exerciseGuideFor("ランジ")?.slug).toBe("lunge");
  });

  it("matches the NEW move-specific figures (accuracy fix)", () => {
    expect(exerciseGuideFor("ランジ")?.slug).toBe("lunge");
    expect(exerciseGuideFor("ウォーキングランジ")?.slug).toBe("lunge");
    expect(exerciseGuideFor("サイドレイズ")?.slug).toBe("lateral-raise");
    expect(exerciseGuideFor("lateral raise")?.slug).toBe("lateral-raise");
    expect(exerciseGuideFor("ダンベルプレス")?.slug).toBe("dumbbell-press");
  });

  it("ブルガリアンスクワット resolves to its OWN figure, NOT plain squat", () => {
    // The exact accuracy bug Ao flagged: a Bulgarian split squat must NOT show a
    // plain squat. Most-specific-first ordering must route it to its own figure.
    expect(exerciseGuideFor("ブルガリアンスクワット")?.slug).toBe("bulgarian-split-squat");
    expect(exerciseGuideFor("ブルガリアンスプリットスクワット")?.slug).toBe("bulgarian-split-squat");
    expect(exerciseGuideFor("スプリットスクワット")?.slug).toBe("bulgarian-split-squat");
    expect(exerciseGuideFor("Bulgarian Split Squat")?.slug).toBe("bulgarian-split-squat");
    // …while a plain squat still goes to squat.
    expect(exerciseGuideFor("スクワット")?.slug).toBe("squat");
  });

  it("returns a full src path under the public guides dir", () => {
    const g = exerciseGuideFor("スクワット");
    expect(g?.src).toBe(`${EXERCISE_GUIDE_DIR}/squat.png?v=${EXERCISE_GUIDE_ASSET_VERSION}`);
    expect(g?.label).toBe("スクワット");
  });

  it("GRACEFUL FALLBACK: unknown / empty names return null (no guessed figure)", () => {
    expect(exerciseGuideFor("謎の種目")).toBeNull();
    expect(exerciseGuideFor("ヨガ")).toBeNull(); // no figure → null, not a wrong one
    expect(exerciseGuideFor("")).toBeNull();
    expect(exerciseGuideFor("   ")).toBeNull();
    // @ts-expect-error — defensive: a null name must not throw.
    expect(exerciseGuideFor(null)).toBeNull();
    // @ts-expect-error — defensive: an undefined name must not throw.
    expect(exerciseGuideFor(undefined)).toBeNull();
  });

  it("every exposed slug resolves to a unique, kebab-case basename", () => {
    const slugs = [...EXERCISE_GUIDE_SLUGS];
    expect(slugs.length).toBeGreaterThanOrEqual(13);
    expect(new Set(slugs).size).toBe(slugs.length); // no duplicates
    for (const s of slugs) expect(s).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("exerciseGuideForOrDefault — B方針: always show SOME figure", () => {
  it("returns the specific figure when the move is known", () => {
    expect(exerciseGuideForOrDefault("スクワット")?.slug).toBe("squat");
    expect(exerciseGuideForOrDefault("ブルガリアンスクワット")?.slug).toBe("bulgarian-split-squat");
    expect(exerciseGuideForOrDefault("懸垂")?.slug).toBe("pull-up");
    // a known specific match is NOT flagged as the default fallback.
    expect(exerciseGuideForOrDefault("スクワット")?.isDefault).toBeFalsy();
  });

  it("falls back to the generic default figure for an UNKNOWN move (no gap)", () => {
    const g = exerciseGuideForOrDefault("謎の種目");
    expect(g?.slug).toBe(DEFAULT_GUIDE_SLUG);
    expect(g?.isDefault).toBe(true);
    expect(g?.src).toBe(`${EXERCISE_GUIDE_DIR}/${DEFAULT_GUIDE_SLUG}.png?v=${EXERCISE_GUIDE_ASSET_VERSION}`);
    // ヨガ has no specific figure → still shows the generic one (not nothing).
    expect(exerciseGuideForOrDefault("ヨガ")?.slug).toBe(DEFAULT_GUIDE_SLUG);
  });

  it("still returns null for an empty / whitespace / nullish name", () => {
    expect(exerciseGuideForOrDefault("")).toBeNull();
    expect(exerciseGuideForOrDefault("   ")).toBeNull();
    // @ts-expect-error — defensive: a null name must not throw.
    expect(exerciseGuideForOrDefault(null)).toBeNull();
    // @ts-expect-error — defensive: an undefined name must not throw.
    expect(exerciseGuideForOrDefault(undefined)).toBeNull();
  });

  it("DEFAULT_GUIDE is a well-formed guide pointing at the default PNG", () => {
    expect(DEFAULT_GUIDE.slug).toBe(DEFAULT_GUIDE_SLUG);
    expect(DEFAULT_GUIDE.isDefault).toBe(true);
    expect(DEFAULT_GUIDE.src).toBe(`${EXERCISE_GUIDE_DIR}/${DEFAULT_GUIDE_SLUG}.png?v=${EXERCISE_GUIDE_ASSET_VERSION}`);
    expect(DEFAULT_GUIDE.slug).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

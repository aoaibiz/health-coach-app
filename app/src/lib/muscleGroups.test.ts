import { describe, it, expect } from "vitest";
import {
  muscleGroupForExercise,
  MUSCLE_GROUP_LABEL,
  MAIN_MUSCLE_GROUPS,
  type MuscleGroup,
} from "./muscleGroups";

describe("muscleGroupForExercise — classification", () => {
  const cases: Array<[string, MuscleGroup]> = [
    // chest
    ["ベンチプレス", "chest"],
    ["ダンベルプレス", "chest"],
    ["腕立て伏せ", "chest"],
    ["プッシュアップ", "chest"],
    ["チェストフライ", "chest"],
    // back
    ["懸垂", "back"],
    ["ラットプルダウン", "back"],
    ["ベントオーバーロウ", "back"],
    ["背筋", "back"],
    ["デッドリフト", "legs"], // posterior-chain primary → legs (intentional)
    // legs
    ["スクワット", "legs"],
    ["レッグプレス", "legs"],
    ["レッグカール", "legs"], // must NOT fall to arms via カール
    ["ランジ", "legs"],
    ["カーフレイズ", "legs"], // レイズ→肩 but カーフ wins (legs ordered before shoulders)
    // shoulders
    ["ショルダープレス", "shoulders"], // before chest press
    ["サイドレイズ", "shoulders"],
    ["ダンベルショルダープレス", "shoulders"],
    // arms
    ["アームカール", "arms"],
    ["バーベルカール", "arms"],
    ["トライセプスプレスダウン", "arms"],
    ["キックバック", "arms"],
    // core
    ["腹筋", "core"],
    ["プランク", "core"],
    ["クランチ", "core"],
    ["ロシアンツイスト", "core"],
    // cardio
    ["ランニング", "cardio"],
    ["ウォーキング", "cardio"],
    ["サイクリング", "cardio"],
    ["水泳", "cardio"],
    // english
    ["Bench Press", "chest"],
    ["Pull Up", "back"],
    ["Squat", "legs"],
    ["Running", "cardio"],
  ];

  for (const [name, expected] of cases) {
    it(`classifies "${name}" → ${expected}`, () => {
      expect(muscleGroupForExercise(name)).toBe(expected);
    });
  }

  it("unknown / empty names map to 'other' (never a guessed muscle)", () => {
    expect(muscleGroupForExercise("謎の種目XYZ")).toBe("other");
    expect(muscleGroupForExercise("")).toBe("other");
    expect(muscleGroupForExercise("   ")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(muscleGroupForExercise("BENCH")).toBe("chest");
    expect(muscleGroupForExercise("RuNnInG")).toBe("cardio");
  });

  it("every main group + cardio/other has a JP label", () => {
    for (const g of [...MAIN_MUSCLE_GROUPS, "cardio", "other"] as MuscleGroup[]) {
      expect(MUSCLE_GROUP_LABEL[g]).toBeTruthy();
    }
  });

  it("MAIN_MUSCLE_GROUPS excludes cardio + other (gap analysis is strength-only)", () => {
    expect(MAIN_MUSCLE_GROUPS).not.toContain("cardio");
    expect(MAIN_MUSCLE_GROUPS).not.toContain("other");
  });
});

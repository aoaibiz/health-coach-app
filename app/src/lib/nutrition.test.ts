import { describe, it, expect } from "vitest";
import { calcBMR, calcTDEE, calcTargets, ACTIVITY_MULTIPLIERS } from "./nutrition";
import type { Profile } from "./types";

/**
 * Reference values are hand-computed from the published formulas:
 *
 *  Mifflin-St Jeor (1990):
 *    male:   BMR = 10·kg + 6.25·cm − 5·age + 5
 *    female: BMR = 10·kg + 6.25·cm − 5·age − 161
 *
 *  Katch-McArdle (uses lean body mass when body-fat% is known):
 *    LBM = kg·(1 − bodyFat%/100)
 *    BMR = 370 + 21.6·LBM
 *
 *  TDEE = BMR × activity multiplier
 *    sedentary 1.2 · light 1.375 · moderate 1.55 · active 1.725 · very_active 1.9
 *
 *  Goal calorie target: lose_fat = TDEE−20% · maintain = TDEE · gain_muscle = TDEE+15%
 */

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    heightCm: 180,
    weightKg: 80,
    bodyType: "average",
    age: 30,
    sex: "male",
    activityLevel: "moderate",
    goal: "maintain",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("calcBMR — Mifflin-St Jeor", () => {
  const cases: Array<{
    name: string;
    p: Partial<Profile>;
    bmr: number;
    method: string;
  }> = [
    // 10·80 + 6.25·180 − 5·30 + 5 = 800 + 1125 − 150 + 5 = 1780
    { name: "male baseline", p: { sex: "male" }, bmr: 1780, method: "Mifflin-St Jeor" },
    // 10·60 + 6.25·165 − 5·25 − 161 = 600 + 1031.25 − 125 − 161 = 1345.25 → 1345
    {
      name: "female",
      p: { sex: "female", weightKg: 60, heightCm: 165, age: 25 },
      bmr: 1345,
      method: "Mifflin-St Jeor",
    },
    // "other" uses the female equation: same as above
    {
      name: "other uses female equation",
      p: { sex: "other", weightKg: 60, heightCm: 165, age: 25 },
      bmr: 1345,
      method: "Mifflin-St Jeor",
    },
    // 10·100 + 6.25·175 − 5·45 + 5 = 1000 + 1093.75 − 225 + 5 = 1873.75 → 1874
    {
      name: "older heavier male rounds half-up",
      p: { sex: "male", weightKg: 100, heightCm: 175, age: 45 },
      bmr: 1874,
      method: "Mifflin-St Jeor",
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.bmr}`, () => {
      const r = calcBMR(profile(c.p));
      expect(r.value).toBe(c.bmr);
      expect(r.method).toBe(c.method);
    });
  }
});

describe("calcBMR — Katch-McArdle (body-fat% provided)", () => {
  const cases: Array<{ name: string; p: Partial<Profile>; bmr: number }> = [
    // LBM = 80·0.80 = 64 ; 370 + 21.6·64 = 370 + 1382.4 = 1752.4 → 1752
    { name: "80kg @20% bf", p: { weightKg: 80, bodyFatPct: 20 }, bmr: 1752 },
    // LBM = 60·0.85 = 51 ; 370 + 21.6·51 = 370 + 1101.6 = 1471.6 → 1472
    {
      name: "60kg @15% bf female (sex ignored by KM)",
      p: { weightKg: 60, bodyFatPct: 15, sex: "female" },
      bmr: 1472,
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.bmr}`, () => {
      const r = calcBMR(profile(c.p));
      expect(r.value).toBe(c.bmr);
      expect(r.method).toBe("Katch-McArdle");
    });
  }

  it("ignores body-fat% of 0 or out-of-range and falls back to Mifflin-St Jeor", () => {
    expect(calcBMR(profile({ bodyFatPct: 0 })).method).toBe("Mifflin-St Jeor");
    expect(calcBMR(profile({ bodyFatPct: -5 })).method).toBe("Mifflin-St Jeor");
    expect(calcBMR(profile({ bodyFatPct: 80 })).method).toBe("Mifflin-St Jeor");
  });
});

describe("calcTDEE — activity multipliers", () => {
  // BMR 1780 across all multipliers
  const cases: Array<{ level: Profile["activityLevel"]; mult: number; tdee: number }> = [
    { level: "sedentary", mult: 1.2, tdee: 2136 }, // 1780·1.2 = 2136
    { level: "light", mult: 1.375, tdee: 2448 }, // 1780·1.375 = 2447.5 → 2448
    { level: "moderate", mult: 1.55, tdee: 2759 }, // 1780·1.55 = 2759
    { level: "active", mult: 1.725, tdee: 3071 }, // 1780·1.725 = 3070.5 → 3071
    { level: "very_active", mult: 1.9, tdee: 3382 }, // 1780·1.9 = 3382
  ];

  for (const c of cases) {
    it(`${c.level} (×${c.mult}) → ${c.tdee}`, () => {
      expect(ACTIVITY_MULTIPLIERS[c.level]).toBe(c.mult);
      expect(calcTDEE(1780, c.level)).toBe(c.tdee);
    });
  }
});

describe("calcTargets — goal calorie adjustment", () => {
  // male baseline: BMR 1780, moderate → TDEE 2759
  const cases: Array<{ goal: Profile["goal"]; calories: number }> = [
    { goal: "maintain", calories: 2759 }, // ×1.00
    { goal: "lose_fat", calories: 2207 }, // 2759·0.80 = 2207.2 → 2207
    { goal: "gain_muscle", calories: 3173 }, // 2759·1.15 = 3172.85 → 3173
  ];

  for (const c of cases) {
    it(`${c.goal} → ${c.calories} kcal`, () => {
      const t = calcTargets(profile({ goal: c.goal }));
      expect(t.bmr).toBe(1780);
      expect(t.tdee).toBe(2759);
      expect(t.calories).toBe(c.calories);
    });
  }
});

describe("calcTargets — PFC grams", () => {
  /**
   * PFC algorithm (deterministic):
   *   protein g = proteinPerKg(goal) × bodyweight, rounded
   *     lose_fat 2.0 · maintain 1.8 · gain_muscle 2.0 g/kg
   *   fat g     = 25% of target calories ÷ 9, rounded
   *   carb g    = (calories − protein·4 − fat·9) ÷ 4, rounded, floored at 0
   */

  it("maintain, 80kg, 2759 kcal", () => {
    const t = calcTargets(profile({ goal: "maintain" }));
    // protein 1.8·80 = 144
    expect(t.proteinG).toBe(144);
    // fat 0.25·2759 = 689.75 /9 = 76.64 → 77
    expect(t.fatG).toBe(77);
    // carb (2759 − 144·4 − 77·9)/4 = (2759 − 576 − 693)/4 = 1490/4 = 372.5 → 373
    expect(t.carbG).toBe(373);
  });

  it("lose_fat, 80kg, 2207 kcal — higher protein per kg", () => {
    const t = calcTargets(profile({ goal: "lose_fat" }));
    // protein 2.0·80 = 160
    expect(t.proteinG).toBe(160);
    // fat 0.25·2207 = 551.75 /9 = 61.31 → 61
    expect(t.fatG).toBe(61);
    // carb (2207 − 160·4 − 61·9)/4 = (2207 − 640 − 549)/4 = 1018/4 = 254.5 → 255
    expect(t.carbG).toBe(255);
  });

  it("gain_muscle, 80kg, 3173 kcal", () => {
    const t = calcTargets(profile({ goal: "gain_muscle" }));
    // protein 2.0·80 = 160
    expect(t.proteinG).toBe(160);
    // fat 0.25·3173 = 793.25 /9 = 88.14 → 88
    expect(t.fatG).toBe(88);
    // carb (3173 − 160·4 − 88·9)/4 = (3173 − 640 − 792)/4 = 1741/4 = 435.25 → 435
    expect(t.carbG).toBe(435);
  });

  it("never produces negative carbs (low-calorie / heavy-protein edge case)", () => {
    // Tiny calorie target with high bodyweight could drive carbs negative — must floor at 0.
    const t = calcTargets(
      profile({ weightKg: 120, goal: "lose_fat", activityLevel: "sedentary", age: 60 }),
    );
    expect(t.carbG).toBeGreaterThanOrEqual(0);
  });

  it("exposes the bmr method used for transparency", () => {
    expect(calcTargets(profile()).bmrMethod).toBe("Mifflin-St Jeor");
    expect(calcTargets(profile({ bodyFatPct: 20 })).bmrMethod).toBe("Katch-McArdle");
  });
});

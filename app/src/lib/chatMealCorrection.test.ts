import { describe, expect, it } from "vitest";
import { buildLoggedMeal } from "./chatMealLog";
import { applyDirectMealCorrectionFromText } from "./chatMealCorrection";
import { toDateKey } from "./date";
import type { Meal } from "./types";

function proteinMeal(): Meal {
  return buildLoggedMeal(
    {
      items: [
        {
          name: "プロテイン",
          grams: 120,
          source: "estimate",
          portion_basis: "estimated",
          kcal: 480,
          protein_g: 96,
          fat_g: 8,
          carb_g: 12,
          micros: { calcium: 240, iron: 12 },
        },
      ],
      type: "間食",
    },
    { date: toDateKey(), now: new Date("2026-06-28T09:00:00.000Z") },
  )!;
}

describe("applyDirectMealCorrectionFromText", () => {
  it("directly fixes a clear protein scoop correction even when the LLM emitted no MEAL_LOG block", () => {
    const meal = proteinMeal();

    const result = applyDirectMealCorrectionFromText(
      "プロテイン、120gじゃなくて1杯あたり10gのすり切り1.5杯です。直して。",
      { meals: [meal], correctId: meal.id, now: new Date("2026-06-28T10:00:00.000Z") },
    );

    expect(result).not.toBeNull();
    expect(result!.mealId).toBe(meal.id);
    const item = result!.meals[0].nutrition?.items?.[0];
    expect(item?.grams).toBe(10);
    expect(item?.qty).toBe(1.5);
    expect(item?.kcal).toBe(60);
    expect(item?.proteinG).toBe(12);
    expect(item?.micros?.calcium).toBe(30);
    expect(item?.micros?.iron).toBe(1.5);
    expect(result!.meals[0].timestamp).toBe(meal.timestamp);
    expect(result!.meals[0].updatedAt).toBe("2026-06-28T10:00:00.000Z");
    expect(result!.note).toContain("保存データも修正しました");
  });

  it("can fix a clear total gram correction for the target item", () => {
    const meal = proteinMeal();

    const result = applyDirectMealCorrectionFromText(
      "プロテインは120gではなく15gに修正して。",
      { meals: [meal], correctId: meal.id },
    );

    const item = result!.meals[0].nutrition?.items?.[0];
    expect(item?.grams).toBe(15);
    expect(item?.qty).toBe(1);
    expect(item?.kcal).toBe(60);
    expect(item?.proteinG).toBe(12);
  });

  it("fixes the saved item before a bad-but-valid LLM correction can keep the old grams", () => {
    const meal = proteinMeal();

    const result = applyDirectMealCorrectionFromText(
      "プロテインの量、120gじゃなく15gです。修正して。",
      { meals: [meal], correctId: meal.id },
    );

    expect(result).not.toBeNull();
    const item = result!.meals[0].nutrition?.items?.[0];
    expect(item?.grams).toBe(15);
    expect(item?.qty).toBe(1);
    expect(result!.meals[0].nutrition?.proteinG).toBe(12);
    expect(result!.meals[0].nutrition?.calories).toBe(60);
  });

  it("does not guess when there is no correction intent or corrected amount", () => {
    const meal = proteinMeal();
    expect(
      applyDirectMealCorrectionFromText("プロテインを1杯あたり10gのすり切り1.5杯で飲みました。", {
        meals: [meal],
        correctId: meal.id,
      }),
    ).toBeNull();
    expect(
      applyDirectMealCorrectionFromText("タンパク質の量が違う気がする。", {
        meals: [meal],
        correctId: meal.id,
      }),
    ).toBeNull();
  });

  it("does not overwrite a different single-item meal just because a correctId exists", () => {
    const rice = buildLoggedMeal({
      items: [{ name: "ごはん", grams: 150, source: "db" }],
      type: "昼",
    })!;

    expect(
      applyDirectMealCorrectionFromText("プロテインは120gではなく15gに修正して。", {
        meals: [rice],
        correctId: rice.id,
      }),
    ).toBeNull();
  });

  it("allows an implicit single-item correction only when the user refers to the current record", () => {
    const meal = proteinMeal();

    const result = applyDirectMealCorrectionFromText("今の記録、それを15gに修正して。", {
      meals: [meal],
      correctId: meal.id,
    });

    expect(result).not.toBeNull();
    const item = result!.meals[0].nutrition?.items?.[0];
    expect(item?.grams).toBe(15);
    expect(item?.kcal).toBe(60);
  });

  it("does not change data when the target item is ambiguous", () => {
    const first = proteinMeal();
    const second: Meal = {
      ...first,
      id: "meal-2",
      nutrition: {
        ...first.nutrition,
        items: [
          first.nutrition!.items![0],
          { ...first.nutrition!.items![0], id: "item-2", name: "ホエイプロテイン" },
        ],
      },
    };

    expect(
      applyDirectMealCorrectionFromText("プロテインは15gに修正して。", {
        meals: [second],
        correctId: second.id,
      }),
    ).toBeNull();
  });
});

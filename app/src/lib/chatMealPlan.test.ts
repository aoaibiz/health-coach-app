import { describe, it, expect } from "vitest";
import {
  applyMealPlan,
  lastPlannedMealIds,
  mealPlanToCalendarPayload,
} from "./chatMealPlan";
import type { MealPlanPayload } from "./mealPlanProtocol";
import type { Meal } from "./types";

const NOW = new Date("2026-06-26T09:00:00+09:00");
const TODAY = "2026-06-26";

function plan(payload: Partial<MealPlanPayload>): MealPlanPayload {
  return { meals: [], ...payload };
}

describe("applyMealPlan — bulk-insert as planned (twin of applyWorkoutPlan)", () => {
  it("inserts proposed meals into TODAY as status 'planned' with grounded nutrition", () => {
    const result = applyMealPlan(
      plan({
        meals: [
          { type: "朝", items: [{ name: "ごはん", grams: 150, source: "db" }] },
          { type: "昼", items: [{ name: "鶏むね肉", grams: 120, source: "db" }] },
        ],
      }),
      { meals: [], date: TODAY, now: NOW },
    );

    expect(result).not.toBeNull();
    expect(result?.meals).toHaveLength(2);
    expect(result?.mealCount).toBe(2);
    expect(result?.date).toBe(TODAY);
    // BOTH are planned + on today, and carry REAL grounded numbers (not the model's).
    for (const m of result!.meals) {
      expect(m.status).toBe("planned");
      expect(m.date).toBe(TODAY);
      // ごはん/鶏むね肉 are 公式DB foods → a positive grounded kcal.
      expect(m.nutrition?.calories).toBeGreaterThan(0);
      expect(m.nutrition?.sourceKind).toBe("db");
    }
    expect(result?.mealIds).toEqual(result!.meals.map((m) => m.id));
  });

  it("attaches the recipe card to the planned meal (presentation-only)", () => {
    const result = applyMealPlan(
      plan({
        meals: [
          {
            type: "夕",
            items: [{ name: "鮭", grams: 80, source: "db" }],
            recipe: { ingredients: ["鮭 80g"], steps: ["焼く"] },
          },
        ],
      }),
      { meals: [], date: TODAY, now: NOW },
    );
    expect(result?.meals[0].recipe).toEqual({ ingredients: ["鮭 80g"], steps: ["焼く"] });
  });

  it("mode 'new' APPENDS a distinct batch (never overwrites prior meals)", () => {
    const existing: Meal[] = [
      { id: "eaten-1", date: TODAY, timestamp: `${TODAY}T07:00:00Z`, type: "朝", text: "トースト" },
    ];
    const result = applyMealPlan(
      plan({ mode: "new", meals: [{ type: "昼", items: [{ name: "ごはん", grams: 150 }] }] }),
      { meals: existing, date: TODAY, now: NOW },
    );
    expect(result?.meals).toHaveLength(2);
    // The pre-existing eaten meal is untouched.
    expect(result?.meals[0]).toEqual(existing[0]);
    expect(result?.meals[1].status).toBe("planned");
  });

  it("returns null when nothing grounds (so the caller writes nothing)", () => {
    // An item with an empty name never reaches the applier in practice (the parser
    // drops it), but defensively: a meal whose items all fail to ground → null.
    const result = applyMealPlan(plan({ meals: [{ items: [] as never }] }), {
      meals: [],
      date: TODAY,
      now: NOW,
    });
    expect(result).toBeNull();
  });
});

describe("applyMealPlan — mode 'correct' replaces the last planned batch only", () => {
  it("replaces the previously-planned meals in place, reusing their ids", () => {
    const first = applyMealPlan(
      plan({ meals: [{ type: "昼", items: [{ name: "ごはん", grams: 150 }] }] }),
      { meals: [], date: TODAY, now: NOW },
    )!;
    const plannedId = first.mealIds[0];

    const corrected = applyMealPlan(
      plan({ mode: "correct", meals: [{ type: "昼", items: [{ name: "そば", grams: 200 }] }] }),
      { meals: first.meals, correctIds: first.mealIds, date: TODAY, now: NOW },
    )!;

    // Still ONE planned meal (replaced, not duplicated), keeping the id.
    const planned = corrected.meals.filter((m) => m.status === "planned");
    expect(planned).toHaveLength(1);
    expect(planned[0].id).toBe(plannedId);
    expect(planned[0].text).toContain("そば");
  });

  it("a 'correct' whose targets were already EATEN safely APPENDS (no ghost update)", () => {
    const first = applyMealPlan(
      plan({ meals: [{ type: "昼", items: [{ name: "ごはん", grams: 150 }] }] }),
      { meals: [], date: TODAY, now: NOW },
    )!;
    // The user pressed 「食べた」 → the planned meal became eaten.
    const afterEat = first.meals.map((m) => ({ ...m, status: "eaten" as const }));

    const corrected = applyMealPlan(
      plan({ mode: "correct", meals: [{ type: "昼", items: [{ name: "そば", grams: 200 }] }] }),
      { meals: afterEat, correctIds: first.mealIds, date: TODAY, now: NOW },
    )!;
    // The eaten meal is preserved; the correction appends a NEW planned meal.
    expect(corrected.meals).toHaveLength(2);
    expect(corrected.meals.find((m) => m.id === first.mealIds[0])?.status).toBe("eaten");
    expect(corrected.meals.filter((m) => m.status === "planned")).toHaveLength(1);
  });

  it("a correction that changes the COUNT leaves no orphan plans", () => {
    const first = applyMealPlan(
      plan({
        meals: [
          { type: "朝", items: [{ name: "ごはん", grams: 150 }] },
          { type: "昼", items: [{ name: "うどん", grams: 200 }] },
        ],
      }),
      { meals: [], date: TODAY, now: NOW },
    )!;
    const corrected = applyMealPlan(
      plan({ mode: "correct", meals: [{ type: "夕", items: [{ name: "鮭", grams: 80 }] }] }),
      { meals: first.meals, correctIds: first.mealIds, date: TODAY, now: NOW },
    )!;
    // Two planned → one planned (the previous batch is fully replaced).
    expect(corrected.meals.filter((m) => m.status === "planned")).toHaveLength(1);
  });
});

describe("lastPlannedMealIds", () => {
  it("returns the newest assistant turn's plannedMeal ids", () => {
    const ids = lastPlannedMealIds([
      { role: "assistant", plannedMeal: { mealIds: ["a", "b"] } },
      { role: "user" },
      { role: "assistant", plannedMeal: { mealIds: ["c", "d"] } },
    ]);
    expect(ids).toEqual(["c", "d"]);
  });
  it("returns null when no assistant turn carried a plan", () => {
    expect(lastPlannedMealIds([{ role: "user" }, { role: "assistant" }])).toBeNull();
  });
});

describe("mealPlanToCalendarPayload — one 食事 event per TIMED planned meal", () => {
  it("builds 食事 events only for meals that carry a valid time", () => {
    const payload = plan({
      meals: [
        {
          type: "朝",
          items: [{ name: "ごはん", grams: 150 }],
          start: "2026-06-26T08:00:00+09:00",
          end: "2026-06-26T08:30:00+09:00",
        },
        // No time → no calendar event (still inserts as a plan elsewhere).
        { type: "昼", items: [{ name: "そば", grams: 200 }] },
      ],
    });
    const cal = mealPlanToCalendarPayload(payload, { timeZone: "Asia/Tokyo" });
    expect(cal).not.toBeNull();
    expect(cal?.items).toHaveLength(1);
    expect(cal?.items[0].type).toBe("食事");
    expect(cal?.items[0].title).toBe("朝食");
    expect(cal?.items[0].start).toBe("2026-06-26T08:00:00+09:00");
    expect(cal?.items[0].notes).toContain("ごはん");
    expect(cal?.timeZone).toBe("Asia/Tokyo");
  });

  it("returns null when NO planned meal carried a time", () => {
    const cal = mealPlanToCalendarPayload(
      plan({ meals: [{ type: "昼", items: [{ name: "ごはん", grams: 150 }] }] }),
    );
    expect(cal).toBeNull();
  });
});

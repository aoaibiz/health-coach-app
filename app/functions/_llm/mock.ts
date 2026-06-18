// MockProvider — used by ALL tests (PRD §8: never hit a real API in tests).
// Production/no-key behavior is handled by the CF handler as a 503; this mock
// remains a deterministic test/dev provider, not a production fallback.
//
// It does NOT do real vision. For text input it does a tiny keyword scan so the
// offline/dev experience and tests are deterministic; for image-only input it
// returns a single generic dish. Crucially it returns name + grams ONLY — never
// kcal/PFC — exactly like the real provider must.

import type { AnalyzeInput, AnalyzeResult, MealVisionProvider } from "./provider";
import type { IdentifiedDish } from "../_lib/ground";

/** Optional canned response, so a test can drive any dish set deterministically. */
export interface MockOptions {
  dishes?: IdentifiedDish[];
  generatedBy?: string;
  /** Force a rejection, to exercise the handler's failure path. */
  throwError?: boolean;
}

// A few common Japanese foods → a DB-resolvable name + a typical portion.
const TEXT_HINTS: Array<{ match: RegExp; dish: IdentifiedDish }> = [
  { match: /(ごはん|ご飯|白米|米飯)/, dish: { name: "ごはん", grams: 150, confidence: "medium" } },
  { match: /ささみ/, dish: { name: "ささみ", grams: 80, confidence: "medium" } },
  { match: /鶏むね|とりむね|鶏胸|むね肉/, dish: { name: "鶏むね肉", grams: 100, confidence: "medium" } },
  { match: /卵|たまご|玉子/, dish: { name: "卵", grams: 50, confidence: "medium" } },
  { match: /バナナ/, dish: { name: "バナナ 生", grams: 100, confidence: "medium" } },
  { match: /納豆/, dish: { name: "だいず 糸引き納豆", grams: 50, confidence: "medium" } },
];

export class MockProvider implements MealVisionProvider {
  constructor(private readonly opts: MockOptions = {}) {}

  async analyzeMeal(input: AnalyzeInput): Promise<AnalyzeResult> {
    if (this.opts.throwError) {
      throw new Error("MockProvider: simulated provider failure");
    }
    const generatedBy = this.opts.generatedBy ?? "MockProvider";

    if (this.opts.dishes) {
      return { dishes: this.opts.dishes, generatedBy };
    }

    const dishes: IdentifiedDish[] = [];
    const text = input.text ?? "";
    for (const { match, dish } of TEXT_HINTS) {
      if (match.test(text)) dishes.push(dish);
    }

    if (dishes.length === 0) {
      // Image-only, or text we couldn't map: return one generic, low-confidence
      // dish. Whether it grounds is up to the DB — we never invent numbers.
      dishes.push({
        name: text.trim() || "食事",
        grams: 200,
        confidence: "low",
      });
    }

    return { dishes, generatedBy };
  }
}

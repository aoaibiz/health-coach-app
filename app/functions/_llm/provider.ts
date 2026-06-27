// Swappable LLM provider boundary for meal-photo / free-text analysis.
//
// CONTRACT (PRD §3.3, anti-fabrication): the provider's ONLY job is to identify
// dish name(s) and estimate portion grams. It MUST NOT return kcal/PFC — those
// are computed downstream from the grounded MEXT DB. Keeping this interface thin
// lets us swap the real model (Claude / OpenAI / Codex SDK) behind an env var
// without touching the handler or the grounding logic, and lets every test run
// against a MockProvider with no network.

import type { Confidence, IdentifiedDish } from "../_lib/ground";

export interface AnalyzeInput {
  /** Base64-encoded downsized JPEG (no data: prefix). Single-photo path. */
  imageBase64?: string;
  /**
   * Multiple base64 JPEGs for ONE meal (e.g. main dish + side + drink shot taken
   * separately). When set, ALL images are attached to a SINGLE analysis call so
   * the model sees the whole meal together and returns one combined dish list.
   * `imageBase64` (single) is treated as the 1-element case of this.
   */
  imageBase64List?: string[];
  /** Free-text description of the meal. */
  text?: string;
  /** Analysis mode: prepared meal by default, or fridge ingredient identification. */
  mode?: "meal" | "fridge";
}

export interface AnalyzeResult {
  dishes: IdentifiedDish[];
  /** Model id / method used, for transparency in the UI. */
  generatedBy: string;
}

export interface MealVisionProvider {
  analyzeMeal(input: AnalyzeInput): Promise<AnalyzeResult>;
}

export type { IdentifiedDish, Confidence };

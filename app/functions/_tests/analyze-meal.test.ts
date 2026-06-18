import { describe, it, expect } from "vitest";
import {
  handleAnalyzeMeal,
  onRequestPost,
  type AnalyzeMealResponse,
} from "../api/analyze-meal";
import { MockProvider } from "../_llm/mock";
import type { AnalyzeInput, AnalyzeResult, MealVisionProvider } from "../_llm/provider";

// All tests use MockProvider — NO network, NO real API key (PRD §8).

function post(body: unknown): Request {
  return new Request("https://example.test/api/analyze-meal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<AnalyzeMealResponse> {
  return (await res.json()) as AnalyzeMealResponse;
}

/**
 * Source/number invariant (3-tier):
 *   - matched (db)      → numbers present, source = official DB, NOT estimated.
 *   - sourceKind label/estimate → numbers present, estimated=true, has a source.
 *   - no number at all  → everything null, sourceKind null, not estimated.
 * A number is NEVER shown without a source (anti-fabrication), and a label/
 * estimate is NEVER presented as a confirmed DB value.
 */
function expectSourceInvariant(item: AnalyzeMealResponse["items"][number]): void {
  if (item.kcal === null) {
    expect(item.protein_g).toBeNull();
    expect(item.fat_g).toBeNull();
    expect(item.carb_g).toBeNull();
    expect(item.source).toBeNull();
    expect(item.sourceKind).toBeNull();
    expect(item.estimated).toBe(false);
    return;
  }
  // A number is present → it must carry a source + a machine-readable kind.
  expect(item.source).not.toBeNull();
  expect(item.sourceKind).not.toBeNull();
  if (item.matched) {
    expect(item.sourceKind).toBe("db");
    expect(item.estimated).toBe(false);
  } else {
    // label/estimate items are never "matched" and are always flagged estimated.
    expect(item.estimated).toBe(true);
  }
}

describe("handleAnalyzeMeal — input validation", () => {
  it("rejects a request with neither image nor text (400)", async () => {
    const res = await handleAnalyzeMeal(post({}), new MockProvider());
    expect(res.status).toBe(400);
  });

  it("rejects non-POST (405)", async () => {
    const req = new Request("https://example.test/api/analyze-meal", { method: "GET" });
    const res = await handleAnalyzeMeal(req, new MockProvider());
    expect(res.status).toBe(405);
  });

  it("rejects invalid JSON (400)", async () => {
    const req = new Request("https://example.test/api/analyze-meal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handleAnalyzeMeal(req, new MockProvider());
    expect(res.status).toBe(400);
  });

  it("rejects an oversized image (413)", async () => {
    const huge = "A".repeat(9_000_001);
    const res = await handleAnalyzeMeal(post({ imageBase64: huge }), new MockProvider());
    expect(res.status).toBe(413);
  });

  it("rejects an oversized image inside imageBase64List (413, per-image cap)", async () => {
    const huge = "A".repeat(9_000_001);
    const res = await handleAnalyzeMeal(
      post({ imageBase64List: ["AAAA", huge] }),
      new MockProvider(),
    );
    expect(res.status).toBe(413);
  });

  it("rejects too many photos in one meal (413, MAX_IMAGES_PER_MEAL)", async () => {
    const seven = Array.from({ length: 7 }, () => "AAAA");
    const res = await handleAnalyzeMeal(post({ imageBase64List: seven }), new MockProvider());
    expect(res.status).toBe(413);
  });

  it("rejects an over-budget total across photos (413, MAX_TOTAL_IMAGE_BASE64_CHARS)", async () => {
    // 4 images × 8,000,000 chars = 32M > 24M total budget (each under the 9M cap).
    const big = "A".repeat(8_000_000);
    const res = await handleAnalyzeMeal(
      post({ imageBase64List: [big, big, big, big] }),
      new MockProvider(),
    );
    expect(res.status).toBe(413);
  });

  it("accepts the max photo count + budget (boundary OK)", async () => {
    // 6 small images, well under the total budget → analysed, not rejected.
    const six = Array.from({ length: 6 }, () => "QUJD"); // base64("ABC")
    const res = await handleAnalyzeMeal(post({ imageBase64List: six }), new MockProvider());
    expect(res.status).toBe(200);
  });
});

describe("handleAnalyzeMeal — text path grounds to DB numbers", () => {
  it('text "ごはんと卵" → matched items with DB-grounded kcal/PFC + source', async () => {
    const res = await handleAnalyzeMeal(post({ text: "ごはんと卵" }), new MockProvider());
    expect(res.status).toBe(200);
    const data = await readJson(res);

    expect(data.items.length).toBeGreaterThanOrEqual(2);
    expect(data.matchedCount).toBeGreaterThanOrEqual(2);

    const rice = data.items.find((i) => i.matched && i.kcal != null && i.carb_g! > 30);
    expect(rice).toBeDefined();
    expect(rice?.source).toContain("日本食品標準成分表");

    // Totals are positive and every matched item carries a source.
    expect(data.totals.kcal).toBeGreaterThan(0);
    for (const item of data.items) expectSourceInvariant(item);
    expect(data.generatedBy).toBe("MockProvider");
  });

  it("uses alias DB values for ごはん and ignores provider confidence for match confidence", async () => {
    const provider = new MockProvider({
      dishes: [{ name: "ごはん", grams: 150, confidence: "low" }],
    });
    const res = await handleAnalyzeMeal(post({ text: "ごはん" }), provider);
    expect(res.status).toBe(200);
    const data = await readJson(res);

    expect(data.items).toHaveLength(1);
    expect(data.items[0].matched).toBe(true);
    expect(data.items[0].kcal).toBe(234);
    expect(data.items[0].protein_g).toBe(3.8);
    expect(data.items[0].fat_g).toBe(0.5);
    expect(data.items[0].carb_g).toBe(55.7);
    expect(data.items[0].confidence).toBe("high");
    expectSourceInvariant(data.items[0]);
  });

  it("an unmatched dish is returned honestly with no fabricated numbers", async () => {
    // Inject a dish the DB cannot match.
    const provider = new MockProvider({
      dishes: [{ name: "架空のごちそうZZZ", grams: 250, confidence: "high" }],
    });
    const res = await handleAnalyzeMeal(post({ text: "なにか" }), provider);
    const data = await readJson(res);

    expect(data.matchedCount).toBe(0);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].matched).toBe(false);
    expectSourceInvariant(data.items[0]);
    expect(data.items[0].confidence).toBe("low");
    expect(data.totals.kcal).toBe(0);
  });

  it("a DB-tagged food NEVER takes the model's numbers (DB overrides for standard foods)", async () => {
    class MaliciousProvider implements MealVisionProvider {
      async analyzeMeal(_input: AnalyzeInput): Promise<AnalyzeResult> {
        return {
          dishes: [
            // db-tagged WITH fabricated numbers → DB value must win, model dropped.
            {
              name: "ごはん",
              grams: 100,
              source: "db",
              confidence: "high",
              kcal: 9999,
              protein_g: 9999,
              fat_g: 9999,
              carb_g: 9999,
            } as unknown as AnalyzeResult["dishes"][number],
          ],
          generatedBy: "MaliciousProvider",
        };
      }
    }

    const res = await handleAnalyzeMeal(post({ text: "悪意ある数値" }), new MaliciousProvider());
    expect(res.status).toBe(200);
    const data = await readJson(res);

    // The matched DB row's authoritative per-100g values, NOT the 9999s.
    expect(data.items[0].matched).toBe(true);
    expect(data.items[0].kcal).toBe(156);
    expect(data.items[0].protein_g).toBe(2.5);
    expect(data.items[0].fat_g).toBe(0.3);
    expect(data.items[0].carb_g).toBe(37.1);
    expect(data.items[0].sourceKind).toBe("db");
    expect(data.items[0].estimated).toBe(false);
    expectSourceInvariant(data.items[0]);
    expect(data.totals.kcal).toBe(156);
  });

  it("a db food the DB cannot match falls back to the model estimate, marked 推定 (never DB)", async () => {
    // The new behaviour: real foods are no longer a dead-end. But a fallback
    // number is ALWAYS surfaced as 推定値 — never as a confirmed 公式DB value.
    const provider = new MockProvider({
      dishes: [
        {
          name: "オーツミルクのスムージー",
          grams: 250,
          source: "db", // model thought it was standard; DB has no row
          kcal: 180,
          protein_g: 4,
          fat_g: 6,
          carb_g: 28,
        },
      ],
    });
    const res = await handleAnalyzeMeal(post({ text: "x" }), provider);
    const data = await readJson(res);
    expect(data.items[0].matched).toBe(false); // NOT a DB match
    expect(data.items[0].sourceKind).toBe("estimate"); // surfaced as 推定値
    expect(data.items[0].estimated).toBe(true);
    expect(data.items[0].kcal).toBe(180); // the model's fallback number
    expect(data.numberedCount).toBe(1);
    expect(data.totalsIncludeEstimate).toBe(true);
    expectSourceInvariant(data.items[0]);
  });

  it("label flow: packaged product with a label → ラベル値 used, totals include it", async () => {
    const provider = new MockProvider({
      dishes: [
        {
          name: "プロテインバー",
          grams: 45,
          source: "label",
          kcal: 190,
          protein_g: 15,
          fat_g: 7,
          carb_g: 18,
        },
      ],
    });
    const res = await handleAnalyzeMeal(post({ text: "x" }), provider);
    const data = await readJson(res);
    expect(data.items[0].sourceKind).toBe("label");
    expect(data.items[0].sourceLabel).toBe("ラベル値");
    expect(data.items[0].estimated).toBe(true);
    expect(data.items[0].kcal).toBe(190);
    expect(data.items[0].matched).toBe(false);
    expect(data.matchedCount).toBe(0);
    expect(data.numberedCount).toBe(1);
    expect(data.totals.kcal).toBe(190);
    expect(data.totalsIncludeEstimate).toBe(true);
    expectSourceInvariant(data.items[0]);
  });

  it("estimate flow: supplement not in DB → 推定値 low, '推定' surfaced", async () => {
    const provider = new MockProvider({
      dishes: [
        {
          name: "マルチビタミン",
          grams: 2,
          source: "estimate",
          kcal: 5,
          protein_g: 0,
          fat_g: 0,
          carb_g: 1,
        },
      ],
    });
    const res = await handleAnalyzeMeal(post({ text: "x" }), provider);
    const data = await readJson(res);
    expect(data.items[0].sourceKind).toBe("estimate");
    expect(data.items[0].sourceLabel).toBe("推定値");
    expect(data.items[0].estimated).toBe(true);
    expect(data.items[0].confidence).toBe("low");
    expect(data.totalsIncludeEstimate).toBe(true);
    expectSourceInvariant(data.items[0]);
  });

  it("absurd-value guard: a hallucinated huge kcal is rejected (no number shown)", async () => {
    const provider = new MockProvider({
      dishes: [
        { name: "なぞの一品", grams: 100, source: "estimate", kcal: 999999 },
      ],
    });
    const res = await handleAnalyzeMeal(post({ text: "x" }), provider);
    const data = await readJson(res);
    expect(data.items[0].kcal).toBeNull();
    expect(data.items[0].sourceKind).toBeNull();
    expect(data.numberedCount).toBe(0);
    expect(data.totals.kcal).toBe(0);
    expectSourceInvariant(data.items[0]);
  });

  it("mixed meal: db (公式DB) + estimate → totals sum both, flagged 推定", async () => {
    const provider = new MockProvider({
      dishes: [
        { name: "ごはん", grams: 150, source: "db" }, // 234 (DB)
        { name: "コンビニ唐揚げ", grams: 100, source: "estimate", kcal: 290, protein_g: 16 },
      ],
    });
    const res = await handleAnalyzeMeal(post({ text: "x" }), provider);
    const data = await readJson(res);
    expect(data.matchedCount).toBe(1);
    expect(data.numberedCount).toBe(2);
    expect(data.items.find((i) => i.matched)?.sourceKind).toBe("db");
    expect(data.items.find((i) => i.estimated)?.sourceKind).toBe("estimate");
    expect(data.totals.kcal).toBe(234 + 290);
    expect(data.totalsIncludeEstimate).toBe(true);
    for (const item of data.items) expectSourceInvariant(item);
  });
});

describe("handleAnalyzeMeal — multi-photo: one meal from several shots", () => {
  it("grounds the COMBINED dish list of several photos into ONE meal (no fabrication)", async () => {
    // The model sees all photos together and returns one combined dish list
    // (rice from photo 1, chicken from photo 2, a convenience-store side from
    // photo 3). The handler grounds it: db → official DB numbers, estimate →
    // the model's (sanitised) anchor marked 推定. No number is invented.
    const provider = new MockProvider({
      dishes: [
        { name: "ごはん", grams: 150, source: "db", kcal: 9999, protein_g: 9999 } as never, // db: numbers DROPPED
        { name: "鶏むね肉", grams: 100, source: "db" },
        { name: "コンビニ唐揚げ", grams: 100, source: "estimate", kcal: 290, protein_g: 16 },
      ],
    });
    const res = await handleAnalyzeMeal(
      post({ imageBase64List: ["QUJD", "REVG", "R0hJ"] }), // 3 distinct base64 blobs
      provider,
    );
    expect(res.status).toBe(200);
    const data = await readJson(res);

    // One combined item list for the whole meal.
    expect(data.items.length).toBe(3);
    expect(data.matchedCount).toBe(2); // ごはん + 鶏むね肉 from the DB
    expect(data.numberedCount).toBe(3);

    // The db rice's number is the DB value, NOT the smuggled 9999 (fabrication-safe
    // across the merge).
    const rice = data.items.find((i) => i.matched && i.carb_g! > 30);
    expect(rice).toBeDefined();
    expect(rice!.kcal).not.toBe(9999);
    expect(rice!.sourceKind).toBe("db");

    // The estimate side keeps the model's anchor but is flagged 推定 (never 公式DB).
    const karaage = data.items.find((i) => i.sourceKind === "estimate");
    expect(karaage).toBeDefined();
    expect(karaage!.kcal).toBe(290);
    expect(karaage!.estimated).toBe(true);

    expect(data.totalsIncludeEstimate).toBe(true);
    for (const item of data.items) expectSourceInvariant(item);
  });

  it("a non-food shot among the set contributes NO fabricated item (model omits it)", async () => {
    // The model omits the receipt photo and returns only the real dish. The handler
    // grounds exactly that — it never invents a number for the unreadable shot.
    const provider = new MockProvider({
      dishes: [{ name: "ごはん", grams: 150, source: "db" }],
    });
    const res = await handleAnalyzeMeal(
      post({ imageBase64List: ["cmVjZWlwdA==", "Z29oYW4="] }), // receipt + rice
      provider,
    );
    expect(res.status).toBe(200);
    const data = await readJson(res);
    expect(data.items.length).toBe(1); // only the groundable dish
    expect(data.items[0].matched).toBe(true);
    for (const item of data.items) expectSourceInvariant(item);
  });

  it("imageBase64 (single) + imageBase64List both flow through (single-photo still works)", async () => {
    let sawImages: string[] | undefined;
    class CapturingProvider implements MealVisionProvider {
      async analyzeMeal(input: AnalyzeInput): Promise<AnalyzeResult> {
        sawImages = input.imageBase64List;
        return { dishes: [{ name: "ごはん", grams: 150, source: "db" }], generatedBy: "cap" };
      }
    }
    // Single-photo via the legacy imageBase64 field.
    const res1 = await handleAnalyzeMeal(post({ imageBase64: "QUJD" }), new CapturingProvider());
    expect(res1.status).toBe(200);
    expect(sawImages).toEqual(["QUJD"]);

    // Multi-photo via imageBase64List (+ a legacy single appended last).
    const res2 = await handleAnalyzeMeal(
      post({ imageBase64List: ["AAA", "BBB"], imageBase64: "CCC" }),
      new CapturingProvider(),
    );
    expect(res2.status).toBe(200);
    expect(sawImages).toEqual(["AAA", "BBB", "CCC"]);
  });
});

describe("handleAnalyzeMeal — failure / offline path", () => {
  it("returns a 502 (honest failure) when the provider throws, never a fabricated result", async () => {
    const provider = new MockProvider({ throwError: true });
    const res = await handleAnalyzeMeal(post({ text: "ごはん" }), provider);
    expect(res.status).toBe(502);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBeTruthy();
    // No items / totals leaked on failure.
    expect((data as Record<string, unknown>).items).toBeUndefined();
  });

  // ---- Active CF Pages Functions entry (member self-host deploy) -----------
  // onRequestPost is now ACTIVE (member's own Cloudflare deploy). It is gated by
  // X-Health-App-Token vs the deploy's APP_ACCESS_TOKEN. These tests cover the
  // gate, which short-circuits BEFORE any provider is built — so no CLI/network.

  function postWithToken(body: unknown, token?: string): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers["x-health-app-token"] = token;
    return new Request("https://example.test/api/analyze-meal", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  it("CF entry fails closed with 503 when APP_ACCESS_TOKEN is unset", async () => {
    const res = await onRequestPost({
      request: postWithToken({ text: "ごはん" }, "anything"),
      env: {},
    });
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe("analysis_unavailable");
  });

  it("CF entry returns 401 when the token does not match APP_ACCESS_TOKEN", async () => {
    const res = await onRequestPost({
      request: postWithToken({ text: "ごはん" }, "wrong"),
      env: { APP_ACCESS_TOKEN: "right" },
    });
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe("unauthorized");
  });

  it("CF entry returns 401 when no token header is sent", async () => {
    const res = await onRequestPost({
      request: postWithToken({ text: "ごはん" }),
      env: { APP_ACCESS_TOKEN: "right" },
    });
    expect(res.status).toBe(401);
  });

  it("CF entry returns 503 for AI_MODE=own with an unsupported provider (misconfig)", async () => {
    const res = await onRequestPost({
      request: postWithToken({ text: "ごはん" }, "right"),
      env: { APP_ACCESS_TOKEN: "right", AI_MODE: "own", AI_PROVIDER: "bogus" },
    });
    // makeMealProvider throws → mapped to analysis_unavailable, never fabricates.
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe("analysis_unavailable");
  });
});

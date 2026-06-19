import { afterEach, describe, it, expect } from "vitest";
import {
  API_TOKEN_STORAGE_KEY,
  analyzeMeal,
  estimateSingleItem,
  hasApiKey,
  toMealNutrition,
  type AnalyzeMealApiResponse,
} from "./analyzeMeal";

function apiResponse(over: Partial<AnalyzeMealApiResponse> = {}): AnalyzeMealApiResponse {
  return {
    items: [
      {
        name: "こめ　［水稲めし］　精白米　うるち米",
        grams: 150,
        kcal: 234,
        protein_g: 3.8,
        fat_g: 0.5,
        carb_g: 55.7,
        source: "日本食品標準成分表（八訂）増補2023年から引用",
        sourceKind: "db",
        sourceLabel: "公式DB",
        estimated: false,
        confidence: "medium",
        matched: true,
      },
    ],
    totals: { kcal: 234, protein_g: 3.8, fat_g: 0.5, carb_g: 55.7 },
    generatedBy: "MockProvider",
    matchedCount: 1,
    numberedCount: 1,
    totalsIncludeEstimate: false,
    ...over,
  };
}

/** A fetch stub that returns a given Response (no network). */
function fetchReturning(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

function setWindowLocalStorage(values: Record<string, string>) {
  const store = new Map(Object.entries(values));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("hasApiKey — access-key presence (unlocks AI features)", () => {
  it("is false when there is no window (SSR/static export)", () => {
    expect(hasApiKey()).toBe(false);
  });

  it("is false when the key is unset, empty, or whitespace-only", () => {
    setWindowLocalStorage({});
    expect(hasApiKey()).toBe(false);
    setWindowLocalStorage({ [API_TOKEN_STORAGE_KEY]: "" });
    expect(hasApiKey()).toBe(false);
    setWindowLocalStorage({ [API_TOKEN_STORAGE_KEY]: "   " });
    expect(hasApiKey()).toBe(false);
  });

  it("is true once a non-blank key is stored", () => {
    setWindowLocalStorage({ [API_TOKEN_STORAGE_KEY]: "secret-token" });
    expect(hasApiKey()).toBe(true);
  });
});

describe("toMealNutrition", () => {
  it("maps matched totals + carries source/confidence/generatedBy", () => {
    const n = toMealNutrition(apiResponse());
    expect(n).not.toBeNull();
    expect(n!.calories).toBe(234);
    expect(n!.proteinG).toBe(3.8);
    expect(n!.source).toContain("日本食品標準成分表");
    expect(n!.confidence).toBe("medium");
    expect(n!.generatedBy).toBe("MockProvider");
  });

  it("returns null ONLY when no number could be sourced at all", () => {
    const n = toMealNutrition(
      apiResponse({
        items: [
          {
            name: "架空料理",
            grams: 200,
            kcal: null,
            protein_g: null,
            fat_g: null,
            carb_g: null,
            source: null,
            sourceKind: null,
            sourceLabel: null,
            estimated: false,
            confidence: "low",
            matched: false,
          },
        ],
        totals: { kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0 },
        matchedCount: 0,
        numberedCount: 0,
        totalsIncludeEstimate: false,
      }),
    );
    expect(n).toBeNull();
  });

  it("returns numbers for an ESTIMATE-only meal (no longer a dead-end) + flags estimated", () => {
    const n = toMealNutrition(
      apiResponse({
        items: [
          {
            name: "コンビニ唐揚げ",
            grams: 100,
            kcal: 290,
            protein_g: 16,
            fat_g: 20,
            carb_g: 12,
            source: "推定値",
            sourceKind: "estimate",
            sourceLabel: "推定値",
            estimated: true,
            confidence: "low",
            matched: false,
          },
        ],
        totals: { kcal: 290, protein_g: 16, fat_g: 20, carb_g: 12 },
        matchedCount: 0,
        numberedCount: 1,
        totalsIncludeEstimate: true,
      }),
    );
    expect(n).not.toBeNull();
    expect(n!.calories).toBe(290);
    expect(n!.estimated).toBe(true);
    expect(n!.sourceKind).toBe("estimate");
    expect(n!.confidence).toBe("low");
  });

  it("a LABEL-only meal → estimated true, sourceKind label", () => {
    const n = toMealNutrition(
      apiResponse({
        items: [
          {
            name: "プロテイン",
            grams: 30,
            kcal: 120,
            protein_g: 24,
            fat_g: 1.5,
            carb_g: 2,
            source: "ラベル値",
            sourceKind: "label",
            sourceLabel: "ラベル値",
            estimated: true,
            confidence: "medium",
            matched: false,
          },
        ],
        totals: { kcal: 120, protein_g: 24, fat_g: 1.5, carb_g: 2 },
        matchedCount: 0,
        numberedCount: 1,
        totalsIncludeEstimate: true,
      }),
    );
    expect(n!.sourceKind).toBe("label");
    expect(n!.estimated).toBe(true);
  });

  it("an all-DB meal → estimated false, sourceKind db, prefers the DB source string", () => {
    const n = toMealNutrition(apiResponse());
    expect(n!.estimated).toBe(false);
    expect(n!.sourceKind).toBe("db");
    expect(n!.source).toContain("日本食品標準成分表");
  });

  it("a mixed (db + estimate) meal → estimated true, sourceKind estimate, DB source string kept", () => {
    const n = toMealNutrition(
      apiResponse({
        items: [
          apiResponse().items[0], // db
          {
            name: "唐揚げ",
            grams: 100,
            kcal: 290,
            protein_g: 16,
            fat_g: 20,
            carb_g: 12,
            source: "推定値",
            sourceKind: "estimate",
            sourceLabel: "推定値",
            estimated: true,
            confidence: "low",
            matched: false,
          },
        ],
        totals: { kcal: 524, protein_g: 19.8, fat_g: 20.5, carb_g: 67.7 },
        matchedCount: 1,
        numberedCount: 2,
        totalsIncludeEstimate: true,
      }),
    );
    expect(n!.sourceKind).toBe("estimate");
    expect(n!.estimated).toBe(true);
    expect(n!.source).toContain("日本食品標準成分表"); // DB source preferred when present
    expect(n!.confidence).toBe("low"); // lowest across numbered items
  });

  it("builds an editable per-item breakdown carrying the DB per-100g basis", () => {
    const n = toMealNutrition(
      apiResponse({
        items: [
          {
            ...apiResponse().items[0],
            name: "ごはん",
            grams: 150,
            kcal: 234,
            foodCode: "01088",
            basisPer100g: { kcal: 156, protein_g: 2.5, fat_g: 0.3, carb_g: 37.1 },
          },
        ],
      }),
    );
    expect(n!.items).toHaveLength(1);
    const item = n!.items![0];
    expect(item.sourceKind).toBe("db");
    expect(item.grams).toBe(150);
    expect(item.qty).toBe(1);
    // The per-100g basis reached the client so it can recompute exactly on edit.
    expect(item.basisPer100g?.kcal).toBe(156);
    expect(item.basisPer100g?.foodCode).toBe("01088");
    // Total mirrors the item.
    expect(n!.calories).toBe(234);
  });

  it("estimate item carries a proportional-scale anchor (no DB basis)", () => {
    const n = toMealNutrition(
      apiResponse({
        items: [
          {
            name: "唐揚げ",
            grams: 100,
            kcal: 290,
            protein_g: 16,
            fat_g: 20,
            carb_g: 12,
            source: "推定値",
            sourceKind: "estimate",
            sourceLabel: "推定値",
            estimated: true,
            confidence: "low",
            matched: false,
          },
        ],
        totals: { kcal: 290, protein_g: 16, fat_g: 20, carb_g: 12 },
        matchedCount: 0,
        numberedCount: 1,
        totalsIncludeEstimate: true,
      }),
    );
    const item = n!.items![0];
    expect(item.sourceKind).toBe("estimate");
    expect(item.basisPer100g).toBeUndefined();
    expect(item.baseGrams).toBe(100);
    expect(item.baseKcal).toBe(290);
  });

  it("summary confidence is the LOWEST across numbered items (honest)", () => {
    const n = toMealNutrition(
      apiResponse({
        items: [
          { ...apiResponse().items[0], confidence: "high" },
          { ...apiResponse().items[0], confidence: "low" },
        ],
        matchedCount: 2,
        numberedCount: 2,
      }),
    );
    expect(n!.confidence).toBe("low");
  });
});

describe("analyzeMeal — success", () => {
  it("returns grounded nutrition from a 200 response", async () => {
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify(apiResponse()), { status: 200 }),
    );
    const n = await analyzeMeal({ text: "ごはん" }, { fetchImpl });
    expect(n.calories).toBe(234);
    expect(n.source).toContain("日本食品標準成分表");
  });

  it("sends X-Health-App-Token when localStorage has a token", async () => {
    setWindowLocalStorage({ [API_TOKEN_STORAGE_KEY]: "secret-token" });
    let headers: Headers;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify(apiResponse()), { status: 200 });
    }) as unknown as typeof fetch;
    await analyzeMeal({ text: "ごはん" }, { fetchImpl });
    expect(headers!.get("X-Health-App-Token")).toBe("secret-token");
  });

  it("omits X-Health-App-Token when localStorage has no token", async () => {
    setWindowLocalStorage({});
    let headers: Headers;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify(apiResponse()), { status: 200 });
    }) as unknown as typeof fetch;
    await analyzeMeal({ text: "ごはん" }, { fetchImpl });
    expect(headers!.has("X-Health-App-Token")).toBe(false);
  });
});

describe("analyzeMeal — offline / failure path (record is kept by caller)", () => {
  it("throws on a network error so the caller keeps the record + can retry", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch"); // offline
    }) as unknown as typeof fetch;
    await expect(analyzeMeal({ text: "ごはん" }, { fetchImpl })).rejects.toThrow();
  });

  it("throws on a non-OK status (e.g. 502) without fabricating numbers", async () => {
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify({ error: "解析に失敗しました" }), { status: 502 }),
    );
    await expect(analyzeMeal({ text: "ごはん" }, { fetchImpl })).rejects.toThrow();
  });

  it("maps 401 to the honest access-key setup message", async () => {
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    await expect(analyzeMeal({ text: "ごはん" }, { fetchImpl })).rejects.toThrow(
      "アクセスキーを設定してください",
    );
  });

  it("throws when NOTHING could be sourced (no db/label/estimate number at all)", async () => {
    const fetchImpl = fetchReturning(
      new Response(
        JSON.stringify(
          apiResponse({
            matchedCount: 0,
            numberedCount: 0,
            totalsIncludeEstimate: false,
            totals: { kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0 },
            items: [],
          }),
        ),
        { status: 200 },
      ),
    );
    await expect(analyzeMeal({ text: "ごはん" }, { fetchImpl })).rejects.toThrow();
  });

  it("rejects empty input before any network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(analyzeMeal({}, { fetchImpl })).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe("estimateSingleItem — DB-miss auto-estimate (honest 推定値, never 0/公式DB)", () => {
  /** An ESTIMATE-only analyze-meal response for an unknown food. */
  const estimateRes = (kcal = 290): AnalyzeMealApiResponse =>
    apiResponse({
      items: [
        {
          name: "コンビニのフライドチキン",
          grams: 120,
          kcal,
          protein_g: 18,
          fat_g: 18,
          carb_g: 14,
          source: "推定値",
          sourceKind: "estimate",
          sourceLabel: "推定値",
          estimated: true,
          confidence: "low",
          matched: false,
        },
      ],
      totals: { kcal, protein_g: 18, fat_g: 18, carb_g: 14 },
      matchedCount: 0,
      numberedCount: 1,
      totalsIncludeEstimate: true,
    });

  it("fills an unknown food with a NON-ZERO 推定値 (estimate), keeping the caller's id+grams", async () => {
    setWindowLocalStorage({ [API_TOKEN_STORAGE_KEY]: "secret-token" });
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify(estimateRes(290)), { status: 200 }),
    );
    const item = await estimateSingleItem("row-1", "コンビニのフライドチキン", 60, { fetchImpl });
    expect(item).not.toBeNull();
    expect(item!.id).toBe("row-1"); // re-keyed to the caller's row
    expect(item!.grams).toBe(60); // re-scaled to the grams the user entered
    expect(item!.sourceKind).toBe("estimate"); // honest 推定値, NEVER 公式DB
    expect(item!.source).toBe("推定値");
    expect(item!.confidence).toBe("low");
    // 290kcal/120g anchor → 60g ≈ 145kcal: a real number, not 0/null.
    expect(item!.kcal).not.toBeNull();
    expect(item!.kcal!).toBeGreaterThan(0);
    expect(item!.kcal!).toBeCloseTo(145, 0);
  });

  it("returns null (NO throw) when there is no access key — manual entry must not break", async () => {
    setWindowLocalStorage({}); // no key
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify(estimateRes()), { status: 200 });
    }) as unknown as typeof fetch;
    const item = await estimateSingleItem("row-1", "謎の食べ物", 100, { fetchImpl });
    expect(item).toBeNull();
    expect(called).toBe(false); // short-circuits before the network call
  });

  it("returns null (NO throw) on an offline/failed analysis — keeps the honest no-number row", async () => {
    setWindowLocalStorage({ [API_TOKEN_STORAGE_KEY]: "secret-token" });
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const item = await estimateSingleItem("row-1", "謎の食べ物", 100, { fetchImpl });
    expect(item).toBeNull();
  });

  it("if the analysis grounds the food to the DB after all, returns the 公式DB item", async () => {
    setWindowLocalStorage({ [API_TOKEN_STORAGE_KEY]: "secret-token" });
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify(apiResponse()), { status: 200 }), // db item
    );
    const item = await estimateSingleItem("row-1", "ごはん", 150, { fetchImpl });
    expect(item).not.toBeNull();
    expect(item!.sourceKind).toBe("db");
    expect(item!.kcal!).toBeGreaterThan(0);
  });
});

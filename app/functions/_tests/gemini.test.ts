import { describe, it, expect } from "vitest";
import {
  GeminiProvider,
  GeminiChatProvider,
  buildMealRequestBody,
  buildChatRequestBody,
  extractTextFromGeminiResponse,
  parseMealResponse,
  collectMealImages,
  type GeminiGenerateContentBody,
} from "../_llm/gemini";
import { MEAL_PROMPT } from "../_llm/codex";
import { buildChatPrompt, type ChatTurn } from "../_llm/chat-prompt";

// These tests cover the PURE shaping of the Gemini provider — request-body
// construction (meal image + chat mapping) and response JSON parsing — and the
// provider classes with an INJECTED fake fetch. They NEVER hit the network and
// need NO real GEMINI_API_KEY (PRD §8: no real API/CLI in tests).

// A 1-element inline_data part is `{ inline_data: { mime_type, data } }`; a text
// part is `{ text }`. Helpers to read them back without `any`.
function inlineDataParts(body: GeminiGenerateContentBody) {
  return body.contents[0].parts.filter(
    (p): p is { inline_data: { mime_type: string; data: string } } =>
      "inline_data" in p,
  );
}
function textParts(body: GeminiGenerateContentBody) {
  return body.contents[0].parts.filter(
    (p): p is { text: string } => "text" in p,
  );
}

describe("collectMealImages — single/multi normalisation", () => {
  it("returns the multi list when present (multi takes precedence)", () => {
    expect(collectMealImages({ imageBase64List: ["a", "b"], imageBase64: "c" })).toEqual([
      "a",
      "b",
    ]);
  });
  it("falls back to the lone single image as a 1-element list", () => {
    expect(collectMealImages({ imageBase64: "only" })).toEqual(["only"]);
  });
  it("drops empty/blank entries", () => {
    expect(collectMealImages({ imageBase64List: ["", "x", ""] })).toEqual(["x"]);
  });
  it("returns [] for a text-only meal", () => {
    expect(collectMealImages({ text: "ごはん" })).toEqual([]);
  });
});

describe("buildMealRequestBody — meal image request shaping", () => {
  it("puts each image into an inline_data part with mime_type image/jpeg + base64 data", () => {
    const body = buildMealRequestBody(["AAA", "BBB"], undefined);
    const imgs = inlineDataParts(body);
    expect(imgs).toHaveLength(2);
    expect(imgs[0].inline_data).toEqual({ mime_type: "image/jpeg", data: "AAA" });
    expect(imgs[1].inline_data).toEqual({ mime_type: "image/jpeg", data: "BBB" });
  });

  it("uses the shared MEAL_PROMPT as the systemInstruction (identical schema to Codex)", () => {
    const body = buildMealRequestBody(["AAA"], undefined);
    expect(body.systemInstruction?.parts.text).toBe(MEAL_PROMPT);
  });

  it("requests application/json output via generationConfig", () => {
    const body = buildMealRequestBody(["AAA"], undefined);
    expect(body.generationConfig?.responseMimeType).toBe("application/json");
  });

  it("appends the optional text hint to the user text part (image + hint)", () => {
    const withHint = buildMealRequestBody(["AAA"], "鶏むね肉とごはん");
    const texts = textParts(withHint);
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toContain("鶏むね肉とごはん");
    // Image part still present and ordered before the trailing text part.
    expect(inlineDataParts(withHint)).toHaveLength(1);

    const noHint = buildMealRequestBody(["AAA"], undefined);
    expect(textParts(noHint)[0].text).not.toContain("参考の説明文");
  });

  it("text-only meal (no images) still produces a single user text part", () => {
    const body = buildMealRequestBody([], "サラダだけ食べた");
    expect(inlineDataParts(body)).toHaveLength(0);
    const texts = textParts(body);
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toContain("サラダだけ食べた");
  });
});

describe("extractTextFromGeminiResponse — response text extraction", () => {
  it("joins the first candidate's text parts and trims the outer whitespace", () => {
    const data = {
      candidates: [{ content: { parts: [{ text: "  hello " }, { text: "world  " }] } }],
    };
    // Parts are concatenated as-is (Gemini streams text continuations); only the
    // outer whitespace is trimmed, so the internal boundary space is preserved.
    expect(extractTextFromGeminiResponse(data)).toBe("hello world");
  });
  it("returns '' for no candidates / malformed shapes", () => {
    expect(extractTextFromGeminiResponse({})).toBe("");
    expect(extractTextFromGeminiResponse({ candidates: [] })).toBe("");
    expect(extractTextFromGeminiResponse(null)).toBe("");
    expect(extractTextFromGeminiResponse({ candidates: [{ content: {} }] })).toBe("");
  });
  it("ignores non-string part text", () => {
    const data = { candidates: [{ content: { parts: [{ text: 42 }, { text: "ok" }] } }] };
    expect(extractTextFromGeminiResponse(data)).toBe("ok");
  });
});

describe("parseMealResponse — dishes via the shared Codex extractor", () => {
  it("parses a JSON dish object from the response text (db source default + numbers dropped)", () => {
    const data = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: '{"dishes":[{"name":"ごはん","grams":150,"confidence":"high"},{"name":"鶏むね肉","grams":100,"confidence":"medium"}]}',
              },
            ],
          },
        },
      ],
    };
    expect(parseMealResponse(data)).toEqual([
      { name: "ごはん", grams: 150, confidence: "high", source: "db" },
      { name: "鶏むね肉", grams: 100, confidence: "medium", source: "db" },
    ]);
  });

  it("keeps label kcal/PFC for a packaged product (anti-fabrication contract intact)", () => {
    const data = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: '```json\n{"dishes":[{"name":"プロテイン","grams":30,"source":"label","confidence":"medium","kcal":120,"protein_g":24,"fat_g":1.5,"carb_g":2}]}\n```',
              },
            ],
          },
        },
      ],
    };
    expect(parseMealResponse(data)).toEqual([
      {
        name: "プロテイン",
        grams: 30,
        source: "label",
        confidence: "medium",
        kcal: 120,
        protein_g: 24,
        fat_g: 1.5,
        carb_g: 2,
      },
    ]);
  });

  it("throws (never fabricates) when the response has no parseable dish JSON", () => {
    const data = { candidates: [{ content: { parts: [{ text: "no json here at all" }] } }] };
    expect(() => parseMealResponse(data)).toThrow();
  });

  it("throws on an empty response", () => {
    expect(() => parseMealResponse({ candidates: [] })).toThrow();
  });
});

describe("buildChatRequestBody — chat content mapping", () => {
  const messages: ChatTurn[] = [
    { role: "user", content: "今日の調子どう？" },
    { role: "assistant", content: "いい感じですよ。" },
    { role: "user", content: "タンパク質足りてる？" },
  ];

  it("maps each turn to Gemini contents (assistant → 'model', user → 'user')", () => {
    const body = buildChatRequestBody(messages, undefined);
    expect(body.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[0].parts).toEqual([{ text: "今日の調子どう？" }]);
    expect(body.contents[1].parts).toEqual([{ text: "いい感じですよ。" }]);
  });

  it("uses the SAME chat-prompt.ts prompt as the Codex path as systemInstruction", () => {
    const body = buildChatRequestBody(messages, undefined);
    expect(body.systemInstruction?.parts.text).toBe(buildChatPrompt(messages, undefined));
  });

  it("does NOT request JSON output for chat (free-text reply)", () => {
    const body = buildChatRequestBody(messages, undefined);
    expect(body.generationConfig?.responseMimeType).toBeUndefined();
  });
});

describe("GeminiProvider.analyzeMeal — with an injected fake fetch", () => {
  function fakeFetch(responseJson: unknown, capture?: (url: string, init: RequestInit) => void) {
    return (async (url: string, init: RequestInit) => {
      capture?.(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => responseJson,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("sends the meal body to the model endpoint with the x-goog-api-key header and parses dishes", async () => {
    let sawUrl = "";
    let sawHeaders: Record<string, string> = {};
    let sawBody: GeminiGenerateContentBody | null = null;
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-2.0-flash",
      fetchImpl: fakeFetch(
        {
          candidates: [
            {
              content: {
                parts: [{ text: '{"dishes":[{"name":"焼き鮭","grams":80,"confidence":"high"}]}' }],
              },
            },
          ],
        },
        (url, init) => {
          sawUrl = url;
          sawHeaders = init.headers as Record<string, string>;
          sawBody = JSON.parse(init.body as string) as GeminiGenerateContentBody;
        },
      ),
    });
    const imageBase64 = Buffer.from("not-a-real-jpeg").toString("base64");
    const result = await provider.analyzeMeal({ imageBase64 });

    expect(sawUrl).toContain("/v1beta/models/gemini-2.0-flash:generateContent");
    // Key travels in the header, never in the URL.
    expect(sawHeaders["x-goog-api-key"]).toBe("test-key");
    expect(sawUrl).not.toContain("test-key");
    const body = sawBody as GeminiGenerateContentBody | null;
    expect(body?.contents[0].parts.some((p) => "inline_data" in p)).toBe(true);

    expect(result.generatedBy).toBe("gemini (gemini-2.0-flash)");
    expect(result.dishes).toEqual([
      { name: "焼き鮭", grams: 80, confidence: "high", source: "db" },
    ]);
  });

  it("throws when no API key is configured (no network call, never fabricates)", async () => {
    let called = false;
    const provider = new GeminiProvider({
      apiKey: "",
      fetchImpl: (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await expect(provider.analyzeMeal({ text: "ごはん" })).rejects.toThrow(/GEMINI_API_KEY/);
    expect(called).toBe(false);
  });

  it("rejects before fetch when given neither image nor text", async () => {
    let called = false;
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await expect(provider.analyzeMeal({})).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("throws a non-secret error on a non-2xx response (status only, no key)", async () => {
    const provider = new GeminiProvider({
      apiKey: "secret-key",
      fetchImpl: (async () =>
        ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch,
    });
    await expect(provider.analyzeMeal({ text: "x" })).rejects.toThrow("Gemini API error: 429");
    await expect(provider.analyzeMeal({ text: "x" })).rejects.not.toThrow(/secret-key/);
  });
});

describe("GeminiChatProvider.reply — with an injected fake fetch", () => {
  it("returns the model's reply text", async () => {
    const provider = new GeminiChatProvider({
      apiKey: "k",
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "いい調子です！" }] } }],
          }),
        }) as unknown as Response) as unknown as typeof fetch,
    });
    const reply = await provider.reply({
      messages: [{ role: "user", content: "調子どう？" }],
    });
    expect(reply).toBe("いい調子です！");
  });

  it("throws (honest failure) on an empty reply", async () => {
    const provider = new GeminiChatProvider({
      apiKey: "k",
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "" }] } }] }),
        }) as unknown as Response) as unknown as typeof fetch,
    });
    await expect(
      provider.reply({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow();
  });

  it("requires at least one message", async () => {
    const provider = new GeminiChatProvider({ apiKey: "k" });
    await expect(provider.reply({ messages: [] })).rejects.toThrow();
  });
});

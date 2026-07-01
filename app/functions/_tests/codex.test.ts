import { describe, it, expect } from "vitest";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CodexProvider,
  extractDishesFromCodexOutput,
  type CodexRunner,
} from "../_llm/codex";

// These tests NEVER spawn the real `codex` CLI. They either call the pure
// parser directly or inject a fake CodexRunner. (PRD §8: no real API/CLI in tests.)

// A realistic codex stdout: banner + agent preamble + the fenced json block.
const CODEX_STDOUT_WITH_BANNER = [
  "OpenAI Codex v0.x  (research preview)",
  "--------",
  "workdir: /tmp/x",
  "model: gpt-5.5",
  "provider: openai",
  "--------",
  "[2026-06-17T00:00:00] thinking",
  "写真を確認しました。料理を特定します。",
  "",
  "```json",
  '{"dishes":[',
  '  {"name":"ごはん","grams":150,"confidence":"high"},',
  '  {"name":"鶏むね肉","grams":100,"confidence":"medium"}',
  "]}",
  "```",
  "",
  "[2026-06-17T00:00:05] tokens used: 1234",
].join("\n");

describe("extractDishesFromCodexOutput — robust parsing", () => {
  it("extracts dishes from a fenced json block buried in banner + preamble", () => {
    const dishes = extractDishesFromCodexOutput(CODEX_STDOUT_WITH_BANNER);
    // No explicit source → defaults to "db" (standard whole foods).
    expect(dishes).toEqual([
      { name: "ごはん", grams: 150, confidence: "high", source: "db" },
      { name: "鶏むね肉", grams: 100, confidence: "medium", source: "db" },
    ]);
  });

  it("prefers the LAST valid json block when several appear (banner noise earlier)", () => {
    const text = [
      "```json",
      '{"dishes":[{"name":"古い間違い","grams":1,"confidence":"low"}]}',
      "```",
      "...more agent chatter...",
      "```json",
      '{"dishes":[{"name":"食パン","grams":60,"confidence":"high"}]}',
      "```",
    ].join("\n");
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([{ name: "食パン", grams: 60, confidence: "high", source: "db" }]);
  });

  it("parses a brace-balanced object even without a code fence", () => {
    const text =
      'preamble text {"dishes":[{"name":"納豆","grams":50,"confidence":"medium"}]} trailing';
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([{ name: "納豆", grams: 50, confidence: "medium", source: "db" }]);
  });

  it("reads source=label + the transcribed label kcal/PFC for packaged products", () => {
    const text =
      '```json\n{"dishes":[{"name":"プロテイン","grams":30,"source":"label","confidence":"medium","kcal":120,"protein_g":24,"fat_g":1.5,"carb_g":2}]}\n```';
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([
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

  it("reads source=estimate + the estimated kcal/PFC for foods not in the DB", () => {
    const text =
      '```json\n{"dishes":[{"name":"外食の唐揚げ","grams":120,"source":"estimate","confidence":"low","kcal":350,"protein_g":20}]}\n```';
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([
      {
        name: "外食の唐揚げ",
        grams: 120,
        source: "estimate",
        confidence: "low",
        kcal: 350,
        protein_g: 20,
      },
    ]);
  });

  it("reads portion_basis so grounding can apply standard portions for uncertain amounts", () => {
    const text =
      '```json\n{"dishes":[{"name":"鶏むね肉 皮なし","grams":20,"portion_basis":"standard","source":"db","confidence":"medium"}]}\n```';
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([
      {
        name: "鶏むね肉 皮なし",
        grams: 20,
        portion_basis: "standard",
        source: "db",
        confidence: "medium",
      },
    ]);
  });

  it("ignores an invalid portion_basis", () => {
    const text =
      '```json\n{"dishes":[{"name":"卵","grams":50,"portion_basis":"tiny-vibes","confidence":"high"}]}\n```';
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([{ name: "卵", grams: 50, confidence: "high", source: "db" }]);
  });

  it("defaults an unknown source to db and an out-of-range/missing confidence to low; drops nameless rows", () => {
    const text =
      '```json\n{"dishes":[{"name":"卵","grams":50,"source":"bogus"},{"grams":10},{"name":"  ","grams":5}]}\n```';
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([{ name: "卵", grams: 50, confidence: "low", source: "db" }]);
  });

  it("drops any kcal/PFC on a db food — the DB supplies those (LLM never overrides db)", () => {
    const text =
      '```json\n{"dishes":[{"name":"ごはん","grams":150,"source":"db","confidence":"high","kcal":9999,"protein_g":9999}]}\n```';
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([{ name: "ごはん", grams: 150, confidence: "high", source: "db" }]);
    // No nutrition keys survive onto a db dish object.
    expect(dishes[0]).not.toHaveProperty("kcal");
    expect(dishes[0]).not.toHaveProperty("protein_g");
  });

  it("drops a negative/garbage model number on a label dish (kept only if valid)", () => {
    const text =
      '```json\n{"dishes":[{"name":"袋菓子","grams":40,"source":"label","kcal":-5,"protein_g":3}]}\n```';
    const dishes = extractDishesFromCodexOutput(text);
    // Negative kcal is dropped at parse; protein_g kept. (ground.ts then rejects
    // a label item that has no usable kcal → honest no-data.)
    expect(dishes[0].kcal).toBeUndefined();
    expect(dishes[0].protein_g).toBe(3);
    expect(dishes[0].source).toBe("label");
  });

  it("coerces a non-numeric grams to 0 (handler/grounding clamps it)", () => {
    const text =
      '```json\n{"dishes":[{"name":"うどん","grams":"たくさん","confidence":"low"}]}\n```';
    const dishes = extractDishesFromCodexOutput(text);
    expect(dishes).toEqual([{ name: "うどん", grams: 0, confidence: "low", source: "db" }]);
  });

  it("throws (no fabrication) when there is no json at all", () => {
    expect(() => extractDishesFromCodexOutput("just some prose, no json here")).toThrow();
  });

  it("throws when the json has an empty dishes array (no parseable dishes)", () => {
    expect(() => extractDishesFromCodexOutput('```json\n{"dishes":[]}\n```')).toThrow();
  });

  it("throws on a schema-mismatched object (no dishes key)", () => {
    expect(() =>
      extractDishesFromCodexOutput('```json\n{"foods":[{"name":"x","grams":1}]}\n```'),
    ).toThrow();
  });
});

describe("CodexProvider.analyzeMeal — with an injected fake runner", () => {
  it("returns dishes (name+grams+confidence only) from a fake codex run", async () => {
    const runner: CodexRunner = async () => ({ stdout: CODEX_STDOUT_WITH_BANNER });
    const provider = new CodexProvider({ runner });
    const result = await provider.analyzeMeal({ text: "ごはんと鶏むね肉" });
    expect(result.generatedBy).toContain("codex-cli");
    expect(result.dishes).toEqual([
      { name: "ごはん", grams: 150, confidence: "high", source: "db" },
      { name: "鶏むね肉", grams: 100, confidence: "medium", source: "db" },
    ]);
  });

  it("passes the image (base64) through to the runner and parses its output", async () => {
    let sawImagePath = "";
    const runner: CodexRunner = async ({ imagePath }) => {
      sawImagePath = imagePath;
      return {
        stdout: '```json\n{"dishes":[{"name":"焼き鮭","grams":80,"confidence":"high"}]}\n```',
      };
    };
    const provider = new CodexProvider({ runner });
    // 1x1 white JPEG-ish bytes are fine; we never decode them in the fake.
    const imageBase64 = Buffer.from("not-a-real-jpeg-but-nonempty").toString("base64");
    const result = await provider.analyzeMeal({ imageBase64 });
    expect(sawImagePath).toMatch(/meal\.jpg$/);
    expect(result.dishes).toEqual([
      { name: "焼き鮭", grams: 80, confidence: "high", source: "db" },
    ]);
  });

  it("runs inside the private temp dir and creates temp files with restrictive modes", async () => {
    const runner: CodexRunner = async ({ imagePath, outFile, cwd }) => {
      expect(cwd).toBe(dirname(imagePath));
      expect(cwd).toBe(dirname(outFile));
      const dirStat = await stat(cwd);
      const imageStat = await stat(imagePath);
      const outStat = await stat(outFile);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(imageStat.mode & 0o777).toBe(0o600);
      expect(outStat.mode & 0o777).toBe(0o600);
      return {
        stdout: '```json\n{"dishes":[{"name":"ごはん","grams":150,"confidence":"high"}]}\n```',
      };
    };
    const provider = new CodexProvider({ runner });
    const imageBase64 = Buffer.from("not-a-real-jpeg-but-nonempty").toString("base64");
    const result = await provider.analyzeMeal({ imageBase64 });
    expect(result.dishes).toEqual([
      { name: "ごはん", grams: 150, confidence: "high", source: "db" },
    ]);
  });

  it("prefers the runner's captured lastMessage over noisy stdout", async () => {
    const runner: CodexRunner = async () => ({
      stdout: "banner only, no json\n```json\n{\"dishes\":[{\"name\":\"間違い\",\"grams\":1}]}\n```",
      lastMessage: '```json\n{"dishes":[{"name":"バナナ 生","grams":100,"confidence":"high"}]}\n```',
    });
    const provider = new CodexProvider({ runner });
    const result = await provider.analyzeMeal({ text: "バナナ" });
    expect(result.dishes).toEqual([
      { name: "バナナ 生", grams: 100, confidence: "high", source: "db" },
    ]);
  });

  it("throws (honest failure) when the runner returns unparseable garbage", async () => {
    const runner: CodexRunner = async () => ({ stdout: "ERROR: model refused. no json." });
    const provider = new CodexProvider({ runner });
    await expect(provider.analyzeMeal({ text: "なにか" })).rejects.toThrow();
  });

  it("propagates CODEX_NOT_FOUND when the runner reports a missing binary", async () => {
    const runner: CodexRunner = async () => {
      throw new Error("CODEX_NOT_FOUND");
    };
    const provider = new CodexProvider({ runner });
    await expect(provider.analyzeMeal({ text: "x" })).rejects.toThrow("CODEX_NOT_FOUND");
  });

  it("rejects empty image bytes without spawning anything", async () => {
    let ran = false;
    const runner: CodexRunner = async () => {
      ran = true;
      return { stdout: "" };
    };
    const provider = new CodexProvider({ runner });
    await expect(provider.analyzeMeal({ imageBase64: "" , text: undefined } as never)).rejects.toThrow();
    // imageBase64 "" is falsy → treated as no image; with no text it must reject
    // before any run.
    expect(ran).toBe(false);
  });

  // ---- Multi-photo (one meal, several shots) -------------------------------
  // The preferred path: ALL photos of one meal are attached as separate `-i`
  // flags to a SINGLE codex call, so the model sees the whole meal together and
  // returns one combined dish list. (Verified empirically that codex `-i` is
  // repeatable; here we assert the provider wires N distinct image paths.)
  it("attaches MULTIPLE images of one meal to a single run (one -i per photo)", async () => {
    let sawPaths: string[] = [];
    const runner: CodexRunner = async ({ imagePaths }) => {
      sawPaths = imagePaths;
      return {
        // ONE combined dish list spanning all the photos (rice + chicken + salad).
        stdout:
          '```json\n{"dishes":[{"name":"ごはん","grams":150,"confidence":"high"},{"name":"鶏むね肉","grams":100,"confidence":"medium"},{"name":"サラダ","grams":80,"confidence":"medium"}]}\n```',
      };
    };
    const provider = new CodexProvider({ runner });
    const img = (s: string) => Buffer.from(s).toString("base64");
    const result = await provider.analyzeMeal({
      imageBase64List: [img("photo-rice"), img("photo-chicken"), img("photo-salad")],
    });
    // Three distinct temp files were created — one per photo.
    expect(sawPaths).toHaveLength(3);
    expect(new Set(sawPaths).size).toBe(3);
    for (const p of sawPaths) expect(p).toMatch(/meal-\d+\.jpg$/);
    // One combined dish list for the whole meal.
    expect(result.dishes.map((d) => d.name)).toEqual(["ごはん", "鶏むね肉", "サラダ"]);
  });

  it("single photo via imageBase64List still uses the legacy meal.jpg name (one -i)", async () => {
    let sawPaths: string[] = [];
    let sawImagePath = "";
    const runner: CodexRunner = async ({ imagePaths, imagePath }) => {
      sawPaths = imagePaths;
      sawImagePath = imagePath;
      return { stdout: '```json\n{"dishes":[{"name":"焼き鮭","grams":80,"confidence":"high"}]}\n```' };
    };
    const provider = new CodexProvider({ runner });
    const result = await provider.analyzeMeal({
      imageBase64List: [Buffer.from("one-photo").toString("base64")],
    });
    expect(sawPaths).toHaveLength(1);
    expect(sawPaths[0]).toMatch(/meal\.jpg$/);
    expect(sawImagePath).toMatch(/meal\.jpg$/); // legacy field = first image
    expect(result.dishes).toEqual([{ name: "焼き鮭", grams: 80, confidence: "high", source: "db" }]);
  });

  it("rejects an empty/blank entry inside the image list (no fabrication, no spawn)", async () => {
    let ran = false;
    const runner: CodexRunner = async () => {
      ran = true;
      return { stdout: "" };
    };
    const provider = new CodexProvider({ runner });
    // A list of only blank strings → no usable images and no text → reject pre-run.
    await expect(provider.analyzeMeal({ imageBase64List: ["", ""] })).rejects.toThrow();
    expect(ran).toBe(false);
  });
});


describe("CodexProvider.generateMealImage - with an injected fake image runner", () => {
  // Valid PNG bytes (8-byte signature + body) — the provider now validates PNG
  // magic before returning (Codex audit S1c).
  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const validPng = Buffer.concat([PNG_HEADER, Buffer.from("png-body")]);

  it("returns a base64 PNG from the fake codex image runner and cleans up temp files", async () => {
    let sawPrompt = "";
    let sawStagePng = "";
    const imageRunner = async ({ prompt, stagePng }: any) => {
      sawPrompt = prompt;
      sawStagePng = stagePng;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(stagePng, validPng);
      return { stdout: `SAVED: ${stagePng}` };
    };
    const provider = new CodexProvider({ imageRunner });
    const result = await provider.generateMealImage({ text: "鮭定食" });
    expect(sawPrompt).toContain("鮭定食");
    expect(result.mimeType).toBe("image/png");
    expect(result.imageBase64).toBe(validPng.toString("base64"));
    await expect(stat(sawStagePng)).rejects.toThrow();
  });

  // Codex audit S1c: a prompt-injected `SAVED: <arbitrary host path>` must NOT be
  // read — only a path INSIDE the per-call temp dir is accepted.
  it("rejects a SAVED path OUTSIDE the per-call temp dir (no arbitrary host read)", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // A file that exists on the host but OUTSIDE the provider's temp dir.
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
    const secret = join(outsideDir, "secret.png");
    await writeFile(secret, validPng); // even a valid PNG must be refused (out of dir)
    const provider = new CodexProvider({
      imageRunner: async ({ stagePng }: any) => {
        // The model is tricked into pointing at the out-of-dir file; the staged
        // file is never written, so only the injected path could be read.
        void stagePng;
        return { stdout: `SAVED: ${secret}` };
      },
    });
    await expect(provider.generateMealImage({ text: "x" })).rejects.toThrow("CODEX_IMAGE_NOT_PRODUCED");
  });

  it("rejects a non-PNG staged file (PNG magic-byte check)", async () => {
    const provider = new CodexProvider({
      imageRunner: async ({ stagePng }: any) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(stagePng, Buffer.from("this is not a png"));
        return { stdout: `SAVED: ${stagePng}` };
      },
    });
    await expect(provider.generateMealImage({ text: "x" })).rejects.toThrow("CODEX_IMAGE_NOT_PRODUCED");
  });

  it("propagates CODEX_NOT_FOUND from the fake image runner", async () => {
    const provider = new CodexProvider({
      imageRunner: async () => {
        throw new Error("CODEX_NOT_FOUND");
      },
    });
    await expect(provider.generateMealImage({ text: "ごはん" })).rejects.toThrow("CODEX_NOT_FOUND");
  });
});

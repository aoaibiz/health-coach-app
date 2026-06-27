import { afterEach, describe, expect, it } from "vitest";
import {
  generateMealImageOnce,
  getMealImageGenerationSnapshot,
  hasPendingMealImageGeneration,
  resetMealImageGenerationJobsForTest,
  subscribeMealImageGenerationJobs,
} from "./mealImageGenerationJob";

function setWindowLocalStorage(values: Record<string, string> = {}) {
  const store = new Map(Object.entries(values));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __HEALTH_APP_TOKEN__: "injected-shared-token",
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    },
  });
}

afterEach(() => {
  resetMealImageGenerationJobsForTest();
  Reflect.deleteProperty(globalThis, "window");
});

describe("generateMealImageOnce", () => {
  it("coalesces duplicate menu prompts into one browser request", async () => {
    setWindowLocalStorage();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      calls += 1;
      await gate;
      return new Response(
        JSON.stringify({
          imageBase64: btoa("fake-png"),
          mimeType: "image/png",
          generatedBy: "fake",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const first = generateMealImageOnce({ text: " 鮭定食 " }, { fetchImpl });
    const second = generateMealImageOnce({ text: "鮭定食" }, { fetchImpl });

    expect(first).toBe(second);
    expect(hasPendingMealImageGeneration("鮭定食")).toBe(true);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(await a.text()).toBe("fake-png");
    expect(await b.text()).toBe("fake-png");
    expect(hasPendingMealImageGeneration("鮭定食")).toBe(false);
  });

  it("clears failed jobs so manual retry can start a fresh request", async () => {
    setWindowLocalStorage();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "fail" }), { status: 502 });
    }) as unknown as typeof fetch;

    await expect(generateMealImageOnce({ text: "ごはん" }, { fetchImpl })).rejects.toThrow(
      "画像生成に失敗しました",
    );
    expect(hasPendingMealImageGeneration("ごはん")).toBe(false);

    await expect(generateMealImageOnce({ text: "ごはん" }, { fetchImpl })).rejects.toThrow(
      "画像生成に失敗しました",
    );
    expect(calls).toBe(2);
  });

  it("notifies subscribers when pending jobs start and finish", async () => {
    setWindowLocalStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots: number[] = [];
    const unsubscribe = subscribeMealImageGenerationJobs(() => {
      snapshots.push(getMealImageGenerationSnapshot());
    });
    const fetchImpl = (async () => {
      await gate;
      return new Response(
        JSON.stringify({
          imageBase64: btoa("fake-png"),
          mimeType: "image/png",
          generatedBy: "fake",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const job = generateMealImageOnce({ text: "焼き芋" }, { fetchImpl });
    expect(snapshots).toHaveLength(1);
    expect(hasPendingMealImageGeneration("焼き芋")).toBe(true);

    release();
    await job;

    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toBeGreaterThan(snapshots[0]);
    expect(hasPendingMealImageGeneration("焼き芋")).toBe(false);
    unsubscribe();
  });
});

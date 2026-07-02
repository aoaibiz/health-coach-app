import { afterEach, describe, it, expect, vi } from "vitest";
import {
  AVATAR_MAX_DATA_URL_CHARS,
  MEAL_GENERATED_IMAGE_MAX_DATA_URL_CHARS,
  compressAvatarToDataUrl,
  compressGeneratedMealImageToDataUrl,
  isValidGeneratedMealImageDataUrl,
} from "./image";

// compressAvatarToDataUrl is the gatekeeper that bounds the SYNCED avatar so it
// can never bloat the per-section sync budget. These tests drive it through a
// minimal canvas/createImageBitmap shim and assert the budget + quality-retry +
// null-on-failure paths (it embeds the image in the synced profile blob, so an
// over-budget result MUST be rejected rather than synced).

/** Build a fake File-ish object (the function only forwards it to createImageBitmap). */
function fakeFile(): File {
  return new Blob(["fake-jpeg"], { type: "image/jpeg" }) as unknown as File;
}

interface CanvasStub {
  width: number;
  height: number;
  getContext: () => unknown;
  toDataURL: (type?: string, q?: number) => string;
}

/** Install window/document/createImageBitmap shims. `toDataURL` is provided by
 *  the test so it can simulate over/under-budget encodings per quality pass. */
function installCanvas(opts: {
  bitmap?: { width: number; height: number } | null;
  getContextReturnsNull?: boolean;
  toDataURL?: (type?: string, q?: number) => string;
}) {
  const bitmap = opts.bitmap ?? { width: 1024, height: 1024 };

  // createImageBitmap: resolve to a bitmap, or reject when bitmap === null.
  const createImageBitmap = vi.fn(async () => {
    if (opts.bitmap === null) throw new Error("decode failed");
    return { ...bitmap, close: () => undefined } as unknown as ImageBitmap;
  });

  const canvas: CanvasStub = {
    width: 0,
    height: 0,
    getContext: () =>
      opts.getContextReturnsNull
        ? null
        : { clearRect: () => undefined, drawImage: () => undefined },
    toDataURL: opts.toDataURL ?? (() => "data:image/jpeg;base64,AAAA"),
  };

  vi.stubGlobal("window", { createImageBitmap });
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag === "canvas") return canvas as unknown as HTMLCanvasElement;
      throw new Error(`unexpected createElement(${tag})`);
    },
  });
  return { canvas };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compressGeneratedMealImageToDataUrl", () => {
  it("returns a bounded square icon data URL for synced meal images", async () => {
    const { canvas } = installCanvas({
      bitmap: { width: 1200, height: 800 },
      toDataURL: () => "data:image/webp;base64,MEAL",
    });

    const url = await compressGeneratedMealImageToDataUrl(new Blob(["png"], { type: "image/png" }));

    expect(url).toBe("data:image/webp;base64,MEAL");
    expect(canvas.width).toBe(192);
    expect(canvas.height).toBe(192);
  });

  it("retries encodings and rejects over-budget generated meal icons", async () => {
    const big =
      "data:image/webp;base64," + "B".repeat(MEAL_GENERATED_IMAGE_MAX_DATA_URL_CHARS + 1);
    installCanvas({ toDataURL: () => big });

    const url = await compressGeneratedMealImageToDataUrl(new Blob(["png"], { type: "image/png" }));

    expect(url).toBeNull();
  });

  it("falls back to a smaller canvas when the first generated meal icon is too large", async () => {
    const big =
      "data:image/webp;base64," + "B".repeat(MEAL_GENERATED_IMAGE_MAX_DATA_URL_CHARS + 1);
    const small = "data:image/webp;base64,SMALL";
    const calls: Array<{ type?: string; quality?: number; width: number; height: number }> = [];
    let canvasRef: CanvasStub | null = null;
    const { canvas } = installCanvas({
      bitmap: { width: 1024, height: 768 },
      toDataURL: (type, quality) => {
        calls.push({
          type,
          quality,
          width: canvasRef?.width ?? 0,
          height: canvasRef?.height ?? 0,
        });
        return calls.length <= 5 ? big : small;
      },
    });
    canvasRef = canvas;

    const url = await compressGeneratedMealImageToDataUrl(new Blob(["png"], { type: "image/png" }));

    expect(url).toBe(small);
    expect(calls.slice(0, 5).every((call) => call.width === 192 && call.height === 192)).toBe(true);
    expect(calls[5]).toMatchObject({
      type: "image/webp",
      quality: 0.82,
      width: 160,
      height: 160,
    });
  });
});

describe("isValidGeneratedMealImageDataUrl", () => {
  it("accepts bounded generated meal icon data URLs with supported image types", () => {
    expect(isValidGeneratedMealImageDataUrl("data:image/webp;base64,AAAA")).toBe(true);
    expect(isValidGeneratedMealImageDataUrl("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(isValidGeneratedMealImageDataUrl("data:image/png;base64,AAAA")).toBe(true);
  });

  it("rejects oversized, non-base64, and unsupported data URLs", () => {
    const oversized =
      "data:image/webp;base64," + "A".repeat(MEAL_GENERATED_IMAGE_MAX_DATA_URL_CHARS);

    expect(isValidGeneratedMealImageDataUrl(oversized)).toBe(false);
    expect(isValidGeneratedMealImageDataUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isValidGeneratedMealImageDataUrl("data:image/webp;utf8,<svg />")).toBe(false);
    expect(isValidGeneratedMealImageDataUrl("https://example.com/image.webp")).toBe(false);
  });
});

describe("compressAvatarToDataUrl — synced-avatar size gatekeeper (issue ③)", () => {
  it("returns a data URL when the first quality pass is under budget", async () => {
    installCanvas({ toDataURL: () => "data:image/jpeg;base64,SMALL" });
    const url = await compressAvatarToDataUrl(fakeFile());
    expect(url).toBe("data:image/jpeg;base64,SMALL");
  });

  it("downscales the canvas to the 512px long-edge cap", async () => {
    const { canvas } = installCanvas({
      bitmap: { width: 2000, height: 1000 },
      toDataURL: () => "data:image/jpeg;base64,X",
    });
    await compressAvatarToDataUrl(fakeFile());
    // Long edge 2000 → scaled to 512; short edge keeps the aspect ratio.
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(256);
  });

  it("retries at lower quality until under budget", async () => {
    const big = "data:image/jpeg;base64," + "B".repeat(AVATAR_MAX_DATA_URL_CHARS);
    const small = "data:image/jpeg;base64,OK";
    const calls: number[] = [];
    installCanvas({
      toDataURL: (_t, q) => {
        calls.push(q as number);
        // First pass (q=0.8) over budget; second pass (q=0.6) fits.
        return calls.length === 1 ? big : small;
      },
    });
    const url = await compressAvatarToDataUrl(fakeFile());
    expect(url).toBe(small);
    expect(calls[0]).toBe(0.8);
    expect(calls[1]).toBe(0.6);
  });

  it("returns null when even the lowest quality stays over budget", async () => {
    const big = "data:image/jpeg;base64," + "B".repeat(AVATAR_MAX_DATA_URL_CHARS + 1);
    installCanvas({ toDataURL: () => big });
    const url = await compressAvatarToDataUrl(fakeFile());
    expect(url).toBeNull();
  });

  it("returns null when the image cannot be decoded", async () => {
    installCanvas({ bitmap: null });
    const url = await compressAvatarToDataUrl(fakeFile());
    expect(url).toBeNull();
  });

  it("returns null when a 2D context is unavailable", async () => {
    installCanvas({ getContextReturnsNull: true });
    const url = await compressAvatarToDataUrl(fakeFile());
    expect(url).toBeNull();
  });

  it("rejects a non-data URL result (e.g. canvas returned junk)", async () => {
    installCanvas({ toDataURL: () => "not-a-data-url" });
    const url = await compressAvatarToDataUrl(fakeFile());
    expect(url).toBeNull();
  });
});

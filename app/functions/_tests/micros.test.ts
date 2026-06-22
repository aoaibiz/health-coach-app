import { describe, it, expect } from "vitest";
import {
  MICRO_KEYS,
  cleanMicros,
  hasAnyMicro,
  microDef,
  scaleMicros,
  sumMicros,
  type Micros,
} from "../_lib/micros";

describe("micros — the shared vitamin/mineral helpers (拡張①)", () => {
  it("MICRO_KEYS covers the requested vitamins + minerals with units", () => {
    // Spot-check a few across both groups + units.
    expect(MICRO_KEYS).toContain("vitaminC");
    expect(MICRO_KEYS).toContain("iron");
    expect(MICRO_KEYS).toContain("potassium");
    expect(microDef("vitaminC")?.unit).toBe("mg");
    expect(microDef("vitaminA")?.unit).toBe("µg"); // RAE in µg
    expect(microDef("iron")?.group).toBe("mineral");
    expect(microDef("vitaminC")?.group).toBe("vitamin");
  });

  describe("scaleMicros", () => {
    it("scales present keys and keeps null for unmeasured ones (never a fabricated 0)", () => {
      const per100: Micros = { iron: 2.0, vitaminC: 35, vitaminB12: null };
      const out = scaleMicros(per100, 1.5); // 150g portion
      expect(out?.iron).toBeCloseTo(3.0, 1);
      expect(out?.vitaminC).toBeCloseTo(52.5, 1);
      // unmeasured key stays null (shown as "—"), NOT 0.
      expect(out?.vitaminB12).toBeNull();
    });

    it("returns undefined for an empty/absent bag (so the field is omitted)", () => {
      expect(scaleMicros(undefined, 2)).toBeUndefined();
      expect(scaleMicros({ iron: null, vitaminC: null }, 2)).toBeUndefined();
    });
  });

  describe("sumMicros", () => {
    it("sums per key only over bags that carry it; null when none do", () => {
      const a: Micros = { iron: 2, vitaminC: 10 };
      const b: Micros = { iron: 3 }; // no vitaminC → doesn't add a fabricated 0
      const out = sumMicros([a, b, undefined]);
      expect(out?.iron).toBeCloseTo(5, 1);
      expect(out?.vitaminC).toBeCloseTo(10, 1); // honest partial total
      // a micro NO bag carried stays null, not 0.
      expect(out?.calcium).toBeNull();
    });

    it("returns undefined when no bag carries any micro", () => {
      expect(sumMicros([undefined, { iron: null }])).toBeUndefined();
    });
  });

  describe("cleanMicros — anti-fabrication of untrusted (model/wire) micros", () => {
    const ceil = (unit: "mg" | "µg") => (unit === "mg" ? 1000 : 1_000_000);

    it("keeps finite non-negative values and drops garbage/negatives/absurd to null", () => {
      const out = cleanMicros(
        { vitaminC: 30, iron: -1, calcium: "x", zinc: 5e9, potassium: 200 },
        ceil,
      );
      expect(out?.vitaminC).toBe(30);
      expect(out?.potassium).toBe(200);
      expect(out?.iron).toBeNull(); // negative → null
      expect(out?.calcium).toBeNull(); // non-number → null
      expect(out?.zinc).toBeNull(); // absurd (> ceil) → null
    });

    it("returns undefined for non-objects / nothing usable", () => {
      expect(cleanMicros(null, ceil)).toBeUndefined();
      expect(cleanMicros("nope", ceil)).toBeUndefined();
      expect(cleanMicros({ iron: -1 }, ceil)).toBeUndefined();
    });
  });

  it("hasAnyMicro is true only when at least one real figure exists", () => {
    expect(hasAnyMicro(undefined)).toBe(false);
    expect(hasAnyMicro({ iron: null, vitaminC: null })).toBe(false);
    expect(hasAnyMicro({ iron: 2 })).toBe(true);
  });
});

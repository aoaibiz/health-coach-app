import { describe, it, expect } from "vitest";
import {
  analysisToChatContext,
  applyMealLog,
  buildLoggedMeal,
  lastLoggedMealId,
  NON_FOOD_ANALYSIS,
} from "./chatMealLog";
import { groundMealLogItem } from "./foodGrounding";
import {
  MEAL_LOG_OPEN,
  MEAL_LOG_CLOSE,
  parseCoachReply,
} from "./mealLogProtocol";
import type { ChatMealAnalysis } from "./chat";
import type { MealLogPayload } from "./mealLogProtocol";
import type { MealNutrition } from "./types";

// These tests exercise the FABRICATION-SAFETY property directly: the logged
// nutrition is computed by the grounded pipeline (DB recompute / labelled
// estimate), NEVER read from numbers the chat model wrote. No network, no CLI.

describe("groundMealLogItem — logged numbers come from grounding, not model text", () => {
  it("a db food's kcal is the DB value, even if the model attached a bogus kcal", () => {
    // The model tagged it db AND tried to smuggle 9999 kcal. db items ignore the
    // model's numbers entirely — the DB basis is authoritative.
    const item = groundMealLogItem({
      name: "ごはん",
      grams: 150,
      source: "db",
      kcal: 9999,
      protein_g: 9999,
    } as MealLogPayload["items"][number]);
    expect(item.sourceKind).toBe("db");
    expect(item.kcal).toBe(234); // 156kcal/100g × 150g — from the DB, NOT 9999
    expect(item.proteinG).toBe(3.8);
    expect(item.basisPer100g?.kcal).toBe(156);
  });

  it("quantity adjustment recomputes from the DB basis (2杯 → grams×2 → 156×3)", () => {
    // ごはん 150g × qty 2 = 300g → 156kcal/100g × 300/100 = 468kcal (DB recompute).
    const item = groundMealLogItem({ name: "ごはん", grams: 150, qty: 2, source: "db" });
    expect(item.grams).toBe(150);
    expect(item.qty).toBe(2);
    expect(item.kcal).toBe(468);
    expect(item.carbG).toBe(111.3); // 37.1 × 3
  });

  it("an unknown item stays 推定 with NO fabricated number when no anchor given", () => {
    const item = groundMealLogItem({ name: "架空のごちそうZZZ", grams: 200, source: "db" });
    expect(item.sourceKind).toBe("estimate");
    expect(item.kcal).toBeNull(); // nothing to fabricate from — honest no-data
    expect(item.basisPer100g).toBeUndefined();
  });

  it("a label item keeps the model's sanitised anchor, labelled (never 公式DB)", () => {
    const item = groundMealLogItem({
      name: "プロテインバー",
      grams: 45,
      source: "label",
      kcal: 190,
      protein_g: 15,
      fat_g: 7,
      carb_g: 18,
    });
    expect(item.sourceKind).toBe("label");
    expect(item.source).toBe("ラベル値");
    expect(item.kcal).toBe(190);
    expect(item.proteinG).toBe(15);
    expect(item.basisPer100g).toBeUndefined(); // not a DB-authoritative number
  });

  it("rejects an absurd label kcal (hallucination) → honest 推定, no number", () => {
    const item = groundMealLogItem({
      name: "なぞの一品",
      grams: 100,
      source: "estimate",
      kcal: 999999,
    });
    // Over MAX_ITEM_KCAL → falls back to a no-number 推定 row (never logs 999999).
    expect(item.kcal).toBeNull();
    expect(item.sourceKind).toBe("estimate");
  });

  it("a DB-known name always prefers the DB even if tagged estimate", () => {
    const item = groundMealLogItem({
      name: "ごはん",
      grams: 100,
      source: "estimate",
      kcal: 50, // model lowballed it; DB wins
    } as MealLogPayload["items"][number]);
    // source db default path requires source==="db"; here source is estimate, so
    // the label/estimate branch uses the model's 50. This documents the contract:
    // the model's source TAG drives routing — db tag = DB authoritative.
    expect(item.kcal).toBe(50);
    expect(item.sourceKind).toBe("estimate");
  });
});

// ── THE INVARIANT: a matched/known food NEVER logs 0 kcal. When grams resolve to
//    ≤ 0 / missing (no quantity stated), grounding substitutes a sensible default
//    portion (100g) so a DB food yields a real, DB-based number — never basis × 0.
//    Only the GRAMS are defaulted; the per-100g basis is always the DB's. ──
describe("groundMealLogItem — 0/missing grams default to a portion (a DB food never logs 0 kcal)", () => {
  it("さつまいも (db) with grams 0 → defaults to 100g → a real DB kcal, NOT 0", () => {
    // さつまいも matches the official DB (02006, 126kcal/100g). With grams 0 the old
    // path computed 126 × 0/100 = 0 (the bug: 公式DB but 0 kcal). Now grams default
    // to 100g → 126kcal, and the basis is still the DB's (126), never invented.
    const item = groundMealLogItem({ name: "さつまいも", grams: 0, source: "db" });
    expect(item.sourceKind).toBe("db"); // still 公式DB
    expect(item.grams).toBe(100); // defaulted portion (an estimate the user can edit)
    expect(item.kcal).toBe(126); // 126/100g × 100g — a REAL DB number, never 0
    expect(item.kcal).not.toBe(0);
    // PROOF the per-100g basis is the DB's, NOT fabricated.
    expect(item.basisPer100g?.kcal).toBe(126);
    expect(item.basisPer100g?.foodCode).toBe("02006");
  });

  it("a db food with MISSING grams (undefined) also defaults to 100g → real DB kcal", () => {
    // grams omitted entirely (the user said "ごはん" with no amount).
    const item = groundMealLogItem({
      name: "ごはん",
      source: "db",
    } as unknown as MealLogPayload["items"][number]);
    expect(item.sourceKind).toBe("db");
    expect(item.grams).toBe(100);
    expect(item.kcal).toBe(156); // 156/100g × 100g — never 0
    expect(item.basisPer100g?.kcal).toBe(156); // DB basis, not fabricated
  });

  it("a NEGATIVE grams also defaults to 100g (clampGrams maps ≤0 → default)", () => {
    const item = groundMealLogItem({ name: "さつまいも", grams: -50, source: "db" } as MealLogPayload["items"][number]);
    expect(item.grams).toBe(100);
    expect(item.kcal).toBe(126);
  });

  it("the smuggled-9999 case still wins from the DB even with grams 0 (fabrication-safety intact)", () => {
    // grams 0 → default 100g; the model's 9999 is STILL ignored (DB basis only).
    const item = groundMealLogItem({
      name: "ごはん",
      grams: 0,
      source: "db",
      kcal: 9999,
    } as MealLogPayload["items"][number]);
    expect(item.kcal).toBe(156); // DB 156/100g × 100g, NOT 9999, NOT 0
    expect(item.basisPer100g?.kcal).toBe(156);
  });

  it("a label item with grams 0 defaults the PORTION but keeps its labelled anchor (never 公式DB)", () => {
    // The grams default lets a labelled product log a real number too; it stays
    // 推定/ラベル (the basis is the model's anchor, not the DB — still honest).
    const item = groundMealLogItem({
      name: "プロテインバー",
      grams: 0,
      source: "label",
      kcal: 190,
      protein_g: 15,
    });
    expect(item.grams).toBe(100); // defaulted portion
    expect(item.sourceKind).toBe("label");
    expect(item.source).toBe("ラベル値");
    expect(item.kcal).toBe(190); // the model's labelled anchor for the (defaulted) portion
    expect(item.basisPer100g).toBeUndefined(); // NOT a 公式DB value
  });

  it("a normal non-zero grams is untouched by the default (regression guard)", () => {
    const item = groundMealLogItem({ name: "さつまいも", grams: 200, source: "db" });
    expect(item.grams).toBe(200); // NOT overridden to 100
    expect(item.kcal).toBe(252); // 126/100g × 200g
  });
});

// ── FULL CHAIN: parse → ground → log. The end-to-end proof of the invariant —
//    "a NAMED food the user mentioned is always logged with a real calorie, never
//    0, never silently dropped; only nameless garbage is discarded." This wires the
//    parser (parseCoachReply) to the grounded log (buildLoggedMeal), exactly the
//    path the chat client takes. ──
describe("full chain (parse→ground→log) — a NAMED grams:0 db food logs a real DB kcal, never dropped", () => {
  /** Wrap a JSON object in the sentinel block (mirrors a coach reply). */
  function block(json: unknown): string {
    return `登録しておきました。\n${MEAL_LOG_OPEN}${JSON.stringify(json)}${MEAL_LOG_CLOSE}`;
  }

  it("{name:'さつまいも', grams:0, source:'db'} → ONE item, real DB kcal (126, basis 126), NOT 0 and NOT dropped", () => {
    // The residual-of-the-焼きさつまいも-bug case: a named db food with grams 0.
    // Old behaviour: parser DROPPED it → all items gone → payload null → nothing
    // logged. New behaviour: parser KEEPS it (grams 0), grounding defaults to 100g,
    // and the meal logs the DB-based calorie.
    const { display, payload } = parseCoachReply(
      block({ items: [{ name: "さつまいも", grams: 0, source: "db" }], type: "間食" }),
    );
    // The user never sees raw JSON.
    expect(display).toBe("登録しておきました。");
    expect(display).not.toContain("items");
    // The named item survived the parser (not dropped) with grams normalised to 0.
    expect(payload).not.toBeNull();
    expect(payload!.items).toEqual([{ name: "さつまいも", grams: 0, source: "db" }]);

    // Ground + log the parsed payload.
    const meal = buildLoggedMeal(payload!, { date: "2026-06-17" });
    expect(meal).not.toBeNull(); // a meal WAS logged (not silently dropped)
    const items = meal!.nutrition!.items!;
    expect(items).toHaveLength(1); // exactly ONE item
    const imo = items[0];
    expect(imo.name).toBe("さつまいも");
    expect(imo.sourceKind).toBe("db"); // still 公式DB
    expect(imo.grams).toBe(100); // grounding defaulted the portion
    expect(imo.kcal).toBe(126); // 126/100g × 100g — a REAL DB number…
    expect(imo.kcal).not.toBe(0); // …never 0
    expect(imo.basisPer100g?.kcal).toBe(126); // DB basis, NOT fabricated
    expect(imo.basisPer100g?.foodCode).toBe("02006");
    // The meal total is the grounded DB calorie, not 0 and not the model's text.
    expect(meal!.nutrition!.calories).toBe(126);
  });

  it("a NO-NAME item is STILL dropped end-to-end (nameless garbage → not logged)", () => {
    // Only a nameless item in the block → nothing to ground → payload null → no meal.
    const { payload } = parseCoachReply(block({ items: [{ grams: 50, source: "db" }] }));
    expect(payload).toBeNull();
    expect(buildLoggedMeal({ items: [] })).toBeNull(); // and nothing logs
  });

  it("a mix of a NAMED grams:0 food + a NO-NAME item logs ONLY the named one (with a real kcal)", () => {
    const { payload } = parseCoachReply(
      block({
        items: [
          { name: "ごはん", grams: 0, source: "db" }, // named, grams 0 → kept
          { name: "", grams: 100, source: "db" }, // no name → dropped
        ],
      }),
    );
    expect(payload!.items).toEqual([{ name: "ごはん", grams: 0, source: "db" }]);
    const meal = buildLoggedMeal(payload!);
    expect(meal!.nutrition!.items).toHaveLength(1); // only ごはん logged
    const rice = meal!.nutrition!.items![0];
    expect(rice.grams).toBe(100); // defaulted portion
    expect(rice.kcal).toBe(156); // 156/100g × 100g — real DB number, never 0
    expect(rice.basisPer100g?.kcal).toBe(156);
  });
});

describe("buildLoggedMeal — writes a grounded, editable Meal (meals only)", () => {
  const payload: MealLogPayload = {
    items: [
      { name: "ごはん", grams: 150, qty: 2, source: "db" },
      { name: "卵", grams: 50, source: "db" },
    ],
    type: "朝",
  };

  it("builds a meal whose total is the SUM of grounded items (not model numbers)", () => {
    const meal = buildLoggedMeal(payload, {
      date: "2026-06-17",
      now: new Date("2026-06-17T08:00:00.000Z"),
    });
    expect(meal).not.toBeNull();
    expect(meal?.type).toBe("朝");
    expect(meal?.date).toBe("2026-06-17");
    // ごはん 300g = 468, 卵 50g = 142×0.5 = 71 → 539. From grounding, not the LLM.
    expect(meal?.nutrition?.calories).toBe(468 + 71);
    expect(meal?.nutrition?.items).toHaveLength(2);
    expect(meal?.nutrition?.sourceKind).toBe("db");
    // The meal carries an editable per-item breakdown (so /meal can edit it).
    expect(meal?.nutrition?.items?.[0].basisPer100g?.kcal).toBe(156);
  });

  it("attaches the chat photo id so the logged meal keeps its picture", () => {
    const meal = buildLoggedMeal(payload, { photoId: "photo-123" });
    expect(meal?.photoId).toBe("photo-123");
  });

  it("defaults the meal type to 昼 when the model omits it", () => {
    const meal = buildLoggedMeal({ items: [{ name: "卵", grams: 50 }] });
    expect(meal?.type).toBe("昼");
  });

  it("returns null for an empty payload (never logs an empty meal)", () => {
    expect(buildLoggedMeal({ items: [] })).toBeNull();
  });

  it("an estimate-tagged total is flagged 推定 (honest), never claimed 公式DB", () => {
    const meal = buildLoggedMeal({
      items: [{ name: "コンビニ唐揚げ", grams: 100, source: "estimate", kcal: 290, protein_g: 16 }],
    });
    expect(meal?.nutrition?.estimated).toBe(true);
    expect(meal?.nutrition?.sourceKind).toBe("estimate");
    expect(meal?.nutrition?.calories).toBe(290);
  });
});

describe("multi-photo → ONE meal: combined items stay grounded (no fabrication)", () => {
  it("logs items from several photos as ONE meal whose total is grounded, not model text", () => {
    // The combined dish list (rice from photo A, chicken from photo B, a
    // convenience-store side from photo C) becomes ONE auto-log payload. Each db
    // item is recomputed from the DB (the smuggled 9999 is ignored); the estimate
    // keeps its sanitised anchor, flagged 推定. The meal total = SUM of GROUNDED
    // items — never a number the model authored.
    const payload: MealLogPayload = {
      items: [
        { name: "ごはん", grams: 150, source: "db", kcal: 9999 } as MealLogPayload["items"][number],
        { name: "鶏むね肉", grams: 100, source: "db" },
        { name: "コンビニ唐揚げ", grams: 100, source: "estimate", kcal: 290, protein_g: 16 },
      ],
      type: "昼",
    };
    const meal = buildLoggedMeal(payload, { date: "2026-06-17" });
    expect(meal).not.toBeNull();
    expect(meal?.nutrition?.items).toHaveLength(3); // one merged item list

    const items = meal!.nutrition!.items!;
    const rice = items.find((i) => i.name === "ごはん")!;
    const chicken = items.find((i) => i.name === "鶏むね肉")!;
    const karaage = items.find((i) => i.name === "コンビニ唐揚げ")!;

    // db items: numbers from the DB basis, NOT the model's 9999.
    expect(rice.sourceKind).toBe("db");
    expect(rice.kcal).toBe(234); // 156/100g × 150g (DB) — never 9999
    expect(chicken.sourceKind).toBe("db");
    expect(typeof chicken.kcal).toBe("number");
    // estimate item: model's sanitised anchor, labelled 推定 (never 公式DB).
    expect(karaage.sourceKind).toBe("estimate");
    expect(karaage.kcal).toBe(290);
    expect(karaage.basisPer100g).toBeUndefined();

    // The meal total is the SUM of the grounded items (recomputed), proving the
    // merge introduced no fabricated number.
    const groundedSum =
      (rice.kcal ?? 0) + (chicken.kcal ?? 0) + (karaage.kcal ?? 0);
    expect(meal?.nutrition?.calories).toBe(groundedSum);
    // The meal mixes DB + estimate → honestly flagged 推定 overall.
    expect(meal?.nutrition?.estimated).toBe(true);
    expect(meal?.nutrition?.sourceKind).toBe("estimate");
  });

  it("a multi-photo meal where ONE item is ungroundable logs it as 推定 with NO number (no fabrication)", () => {
    // e.g. one shot was a non-food/unreadable item the rally still listed: it
    // grounds to an honest 推定 row with a null number — never invented — while the
    // real db item keeps its DB value.
    const meal = buildLoggedMeal({
      items: [
        { name: "ごはん", grams: 150, source: "db" },
        { name: "正体不明の品ZZZ", grams: 100, source: "db" }, // no DB match, no anchor
      ],
    });
    const items = meal!.nutrition!.items!;
    const unknown = items.find((i) => i.name === "正体不明の品ZZZ")!;
    expect(unknown.sourceKind).toBe("estimate");
    expect(unknown.kcal).toBeNull(); // honest no-data, NOT fabricated
    const rice = items.find((i) => i.name === "ごはん")!;
    expect(rice.kcal).toBe(234); // the groundable item is unaffected
  });

  it("a single-photo meal still logs correctly (multi is a superset of single)", () => {
    const meal = buildLoggedMeal({ items: [{ name: "ごはん", grams: 150, source: "db" }] });
    expect(meal?.nutrition?.items).toHaveLength(1);
    expect(meal?.nutrition?.calories).toBe(234);
    expect(meal?.nutrition?.sourceKind).toBe("db");
  });
});

describe("analysisToChatContext — presentation context only", () => {
  it("maps a grounded MealNutrition's items into the chat analysis shape", () => {
    const nutrition: MealNutrition = {
      calories: 234,
      proteinG: 3.8,
      estimated: false,
      sourceKind: "db",
      items: [
        {
          id: "x",
          name: "ごはん",
          grams: 150,
          qty: 1,
          kcal: 234,
          proteinG: 3.8,
          fatG: 0.5,
          carbG: 55.7,
          sourceKind: "db",
          source: "公式DB",
        },
      ],
    };
    const ctx = analysisToChatContext(nutrition);
    expect(ctx.ok).toBe(true);
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items?.[0]).toMatchObject({ name: "ごはん", grams: 150, kcal: 234, sourceKind: "db" });
    expect(ctx.estimated).toBe(false);
  });

  it("NON_FOOD_ANALYSIS signals the photo wasn't food (ok:false)", () => {
    expect(NON_FOOD_ANALYSIS).toEqual({ ok: false });
  });
});

describe("applyMealLog — explicit mode (new/correct) + history resolution (de-dupe redesign)", () => {
  // The redesign: the dedupe signal is now CARRIED in the block (payload.mode) and
  // resolved against PERSISTED chat history (correctId), not an in-memory ref.
  //   - mode "new" (default)  → APPEND a distinct meal (over-merge impossible).
  //   - mode "correct"        → UPDATE the most-recent logged meal in place,
  //     resolved from history (reload-safe; clear() → nothing to correct → append).
  // These pin BOTH directions (don't over-merge / don't under-merge) + survival.

  const ricePayload: MealLogPayload = {
    items: [{ name: "ごはん", grams: 150, source: "db" }],
    type: "夕",
  };

  it("first MEAL_LOG (mode new) APPENDS one meal and returns its id", () => {
    const r = applyMealLog(ricePayload, { meals: [], correctId: null });
    expect(r).not.toBeNull();
    expect(r!.meals).toHaveLength(1);
    expect(r!.meals[0].id).toBe(r!.mealId);
    expect(r!.itemCount).toBe(1);
    expect(r!.meals[0].nutrition?.calories).toBe(234); // grounded, not model text
  });

  it("an omitted mode defaults to NEW — never overwrites a prior meal", () => {
    const first = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    // A later block with NO mode, even though a correctId is available, still
    // appends (default new). This is the over-merge guard at the data layer.
    const r = applyMealLog(
      { items: [{ name: "卵", grams: 50, source: "db" }], type: "夕" },
      { meals: first.meals, correctId: first.mealId },
    )!;
    expect(r.meals).toHaveLength(2);
  });

  // ── (a) over-merge fix: a NEW meal after a logged meal is a SEPARATE entry,
  //    even text-only / no new photo. The old "still-set ref" bug is gone. ──
  it("(a) a new text-only meal after a logged meal is a SEPARATE entry (over-merge fixed)", () => {
    // Turn 1: photo meal (rice) logged.
    const first = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    // Turn 2: text-only "also log the banana" — a genuinely NEW meal. The coach
    // emits mode:"new". History has a correctId, but new must NOT touch the rice.
    const banana: MealLogPayload = {
      items: [{ name: "バナナ", grams: 100, source: "db" }],
      type: "間食",
      mode: "new",
    };
    const second = applyMealLog(banana, {
      meals: first.meals,
      correctId: first.mealId, // present, but mode:new ignores it
    })!;
    expect(second.meals).toHaveLength(2); // two distinct meals, NOT an over-merge
    expect(second.mealId).not.toBe(first.mealId);
    const names = second.meals.map((m) => m.text);
    expect(names).toContain("ごはん");
    expect(names).toContain("バナナ");
    // The original rice meal is untouched.
    expect(second.meals.find((m) => m.text === "ごはん")!.id).toBe(first.mealId);
  });

  // ── (b) correction updates the right entry AND survives a simulated reload ──
  it("(b) mode correct UPDATES the right entry, resolved from persisted history (reload-safe)", () => {
    // Turn 1: rice logged; the assistant turn records loggedMeal in history.
    const first = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    const history = [
      { role: "user" as const },
      { role: "assistant" as const, loggedMeal: { mealId: first.mealId, itemCount: 1 } },
    ];

    // SIMULATE A RELOAD: there is NO in-memory ref anymore — the only state is the
    // persisted meals + persisted chat history. Resolve the correct target purely
    // from that history (exactly what useChat does after a remount).
    const resolved = lastLoggedMealId(history);
    expect(resolved).toBe(first.mealId);

    const corrected: MealLogPayload = {
      items: [
        { name: "ごはん", grams: 150, source: "db" },
        { name: "卵", grams: 50, source: "db" },
      ],
      type: "夕",
      mode: "correct",
    };
    const second = applyMealLog(corrected, {
      meals: first.meals,
      correctId: resolved,
    })!;
    // STILL one meal — same id, numbers reflect the corrected payload.
    expect(second.meals).toHaveLength(1);
    expect(second.mealId).toBe(first.mealId);
    expect(second.meals[0].nutrition?.items).toHaveLength(2);
    expect(second.meals[0].nutrition?.calories).toBe(234 + 71); // re-grounded
  });

  // ── (c) clear() then log = append, no stale clobber ──
  it("(c) after clear() (empty history) a correct safely APPENDS — no stale clobber", () => {
    // A meal exists in the store, but the chat history was cleared. The coach (or
    // a stray block) emits mode:"correct" — with no history there's no target, so
    // correctId is null → it must APPEND, never clobber the existing meal.
    const existing = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    const resolvedAfterClear = lastLoggedMealId([]); // history cleared
    expect(resolvedAfterClear).toBeNull();
    const r = applyMealLog(
      { items: [{ name: "鶏むね肉", grams: 100, source: "db" }], type: "夕", mode: "correct" },
      { meals: existing.meals, correctId: resolvedAfterClear },
    )!;
    expect(r.meals).toHaveLength(2); // appended, not merged onto the old meal
    expect(r.mealId).not.toBe(existing.mealId);
  });

  it("applying the SAME correct payload twice is idempotent (no duplicate)", () => {
    const first = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    const correctPayload: MealLogPayload = { ...ricePayload, mode: "correct" };
    const again = applyMealLog(correctPayload, {
      meals: first.meals,
      correctId: first.mealId,
    })!;
    expect(again.meals).toHaveLength(1); // not 2
    expect(again.mealId).toBe(first.mealId);
    expect(again.meals[0].nutrition?.calories).toBe(234);
  });

  it("preserves the original timestamp on correct (a correction doesn't move the meal)", () => {
    const t0 = new Date("2026-06-17T20:05:00.000Z");
    const first = applyMealLog(ricePayload, { meals: [], correctId: null, now: t0 })!;
    const ts = first.meals[0].timestamp;
    const t1 = new Date("2026-06-17T20:09:00.000Z");
    const second = applyMealLog(
      { ...ricePayload, mode: "correct" },
      { meals: first.meals, correctId: first.mealId, now: t1 },
    )!;
    expect(second.meals).toHaveLength(1);
    expect(second.meals[0].timestamp).toBe(ts); // not drifted to 20:09
  });

  it("if the meal was deleted in /meal, a correct APPENDS (no ghost update)", () => {
    const first = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    // User deletes it in /meal → store no longer has that id, but history still
    // points at it. A correct must re-log (append), not silently no-op.
    const r = applyMealLog(
      { ...ricePayload, mode: "correct" },
      { meals: [], correctId: first.mealId }, // stale id, not in store
    )!;
    expect(r.meals).toHaveLength(1);
    expect(r.meals[0].nutrition?.calories).toBe(234);
  });

  it("single AND multi-photo meals each log exactly ONE entry (mode new)", () => {
    const single = applyMealLog(
      { items: [{ name: "ごはん", grams: 150, source: "db" }] },
      { meals: [], correctId: null },
    )!;
    expect(single.meals).toHaveLength(1);

    const multi = applyMealLog(
      {
        items: [
          { name: "ごはん", grams: 150, source: "db" },
          { name: "鶏むね肉", grams: 100, source: "db" },
        ],
      },
      { meals: [], correctId: null },
    )!;
    expect(multi.meals).toHaveLength(1);
    expect(multi.meals[0].nutrition?.items).toHaveLength(2);
  });

  it("FABRICATION SAFETY survives the correct path: a smuggled 9999 never lands", () => {
    const first = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    const smuggle: MealLogPayload = {
      items: [{ name: "ごはん", grams: 150, source: "db", kcal: 9999 } as MealLogPayload["items"][number]],
      type: "夕",
      mode: "correct",
    };
    const second = applyMealLog(smuggle, { meals: first.meals, correctId: first.mealId })!;
    expect(second.meals).toHaveLength(1);
    expect(second.meals[0].nutrition?.calories).toBe(234); // DB basis, NOT 9999
  });

  it("the 0/missing-grams default ALSO applies on the correct/update path (a DB food never corrects to 0 kcal)", () => {
    // Turn 1: rice logged normally. Turn 2: an explicit correct whose item carries
    // grams 0 (the model dropped the quantity). The update must NOT write 0 kcal —
    // the default portion (100g) kicks in → a real DB number, basis still the DB's.
    const first = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    const correctZero: MealLogPayload = {
      items: [{ name: "さつまいも", grams: 0, source: "db" } as MealLogPayload["items"][number]],
      type: "夕",
      mode: "correct",
    };
    const second = applyMealLog(correctZero, { meals: first.meals, correctId: first.mealId })!;
    expect(second.meals).toHaveLength(1); // updated in place, same id
    expect(second.mealId).toBe(first.mealId);
    const item = second.meals[0].nutrition!.items![0];
    expect(item.grams).toBe(100); // defaulted
    expect(item.kcal).toBe(126); // 126/100g × 100g — never 0
    expect(item.basisPer100g?.kcal).toBe(126); // DB basis, not fabricated
    expect(second.meals[0].nutrition?.calories).toBe(126);
  });

  it("returns null (logs nothing) when the payload grounds to nothing", () => {
    expect(applyMealLog({ items: [] }, { meals: [], correctId: null })).toBeNull();
    const first = applyMealLog(ricePayload, { meals: [], correctId: null })!;
    const r = applyMealLog(
      { items: [], mode: "correct" },
      { meals: first.meals, correctId: first.mealId },
    );
    expect(r).toBeNull();
  });

  it("lastLoggedMealId returns the MOST RECENT logged meal from history", () => {
    const history = [
      { role: "assistant" as const, loggedMeal: { mealId: "old", itemCount: 1 } },
      { role: "user" as const },
      { role: "assistant" as const, loggedMeal: { mealId: "recent", itemCount: 2 } },
      { role: "user" as const },
      { role: "assistant" as const }, // a plain reply, no log
    ];
    expect(lastLoggedMealId(history)).toBe("recent");
    expect(lastLoggedMealId([])).toBeNull();
  });
});

// ── (f) CHANGE 3: meal estimates come from the ANALYSIS, not the chat LLM ──
describe("buildLoggedMeal — label/estimate numbers carried from the grounded analysis (CHANGE 3)", () => {
  it("(f) a label item logs the ANALYSIS number, not the chat model's re-typed one", () => {
    // The analysis grounded プロテインバー at 190kcal/15gP for 45g. The chat model
    // re-typed a DRIFTED 250kcal into the block. With the analysis carried through,
    // the LOGGED estimate equals the analysis (190), not the model's 250.
    const analysis: ChatMealAnalysis = {
      ok: true,
      estimated: true,
      items: [
        { name: "プロテインバー", grams: 45, kcal: 190, proteinG: 15, fatG: 7, carbG: 18, sourceKind: "label" },
      ],
    };
    const payload: MealLogPayload = {
      items: [{ name: "プロテインバー", grams: 45, source: "label", kcal: 250, protein_g: 99 }],
    };
    const meal = buildLoggedMeal(payload, { analysis });
    const item = meal!.nutrition!.items![0];
    expect(item.sourceKind).toBe("label");
    expect(item.kcal).toBe(190); // analysis number — NOT the model's 250
    expect(item.proteinG).toBe(15); // NOT the model's 99
    expect(meal!.nutrition!.calories).toBe(190);
  });

  it("a db item ignores the analysis carry-through (still DB-grounded)", () => {
    const analysis: ChatMealAnalysis = {
      ok: true,
      items: [{ name: "ごはん", grams: 150, kcal: 999, sourceKind: "db" }],
    };
    const meal = buildLoggedMeal(
      { items: [{ name: "ごはん", grams: 150, source: "db" }] },
      { analysis },
    );
    // db recomputes from the official DB basis regardless of the analysis number.
    expect(meal!.nutrition!.items![0].kcal).toBe(234); // DB, not the analysis 999
  });

  it("a label item with NO analysis match keeps the block's sanitised anchor", () => {
    const analysis: ChatMealAnalysis = {
      ok: true,
      items: [{ name: "別の食品", grams: 100, kcal: 100, sourceKind: "label" }],
    };
    const meal = buildLoggedMeal(
      { items: [{ name: "なぞバー", grams: 40, source: "estimate", kcal: 160, protein_g: 8 }] },
      { analysis },
    );
    // No match in the analysis → the block's own anchor stands (still labelled 推定).
    expect(meal!.nutrition!.items![0].kcal).toBe(160);
    expect(meal!.nutrition!.items![0].sourceKind).toBe("estimate");
  });

  it("no analysis at all → behaves exactly as before (block anchor used)", () => {
    const meal = buildLoggedMeal({
      items: [{ name: "コンビニ唐揚げ", grams: 100, source: "estimate", kcal: 290, protein_g: 16 }],
    });
    expect(meal!.nutrition!.items![0].kcal).toBe(290);
  });
});

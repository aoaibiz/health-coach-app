import { describe, it, expect } from "vitest";
import {
  WORKOUT_PLAN_OPEN,
  WORKOUT_PLAN_CLOSE,
  hasWorkoutPlanBlock,
  parseWorkoutPlanReply,
} from "./workoutPlanProtocol";

/** Wrap a JSON object in the workout-PLAN sentinel block, with optional prose. */
function withBlock(json: unknown, prose = "今日の運動メニューを入れておきました。"): string {
  return `${prose}\n${WORKOUT_PLAN_OPEN}${JSON.stringify(json)}${WORKOUT_PLAN_CLOSE}`;
}

describe("parseWorkoutPlanReply — strips the plan block, keeps natural prose", () => {
  it("parses a valid menu (exercises + session time) and removes it from the text", () => {
    const raw = withBlock({
      exercises: [
        { name: "ベンチプレス", sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }] },
        { name: "腹筋", sets: [{ reps: 20 }] },
      ],
      start: "2026-06-26T18:00:00+09:00",
      end: "2026-06-26T19:00:00+09:00",
      mode: "new",
    });
    const { display, payload } = parseWorkoutPlanReply(raw);

    // The user sees ONLY natural prose — never the JSON or the sentinels.
    expect(display).toBe("今日の運動メニューを入れておきました。");
    expect(display).not.toContain(WORKOUT_PLAN_OPEN);
    expect(display).not.toContain("exercises");
    expect(display).not.toContain("start");

    expect(payload).not.toBeNull();
    expect(payload?.exercises).toHaveLength(2);
    expect(payload?.exercises[0]).toEqual({
      name: "ベンチプレス",
      sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }],
    });
    expect(payload?.exercises[1]).toEqual({ name: "腹筋", sets: [{ reps: 20 }] });
    expect(payload?.start).toBe("2026-06-26T18:00:00+09:00");
    expect(payload?.end).toBe("2026-06-26T19:00:00+09:00");
    expect(payload?.mode).toBe("new");
  });

  it("parses a menu with NO session time (calendar reflection optional)", () => {
    const raw = withBlock({ exercises: [{ name: "スクワット", sets: [{ reps: 15 }] }] });
    const { payload } = parseWorkoutPlanReply(raw);
    expect(payload?.exercises).toHaveLength(1);
    // No start/end → they stay undefined (the plan still inserts; calendar skipped).
    expect(payload?.start).toBeUndefined();
    expect(payload?.end).toBeUndefined();
  });

  it("DROPS a zoneless / inverted / partial session time (never an invented time)", () => {
    const zoneless = withBlock({
      exercises: [{ name: "腹筋", sets: [{ reps: 20 }] }],
      start: "2026-06-26T18:00:00", // no zone
      end: "2026-06-26T19:00:00",
    });
    expect(parseWorkoutPlanReply(zoneless).payload?.start).toBeUndefined();

    const inverted = withBlock({
      exercises: [{ name: "腹筋", sets: [{ reps: 20 }] }],
      start: "2026-06-26T19:00:00+09:00",
      end: "2026-06-26T18:00:00+09:00", // end <= start
    });
    expect(parseWorkoutPlanReply(inverted).payload?.start).toBeUndefined();

    const partial = withBlock({
      exercises: [{ name: "腹筋", sets: [{ reps: 20 }] }],
      start: "2026-06-26T18:00:00+09:00", // end missing
    });
    expect(parseWorkoutPlanReply(partial).payload?.start).toBeUndefined();
  });

  it("parses a cardio menu item (durationMin) and intensity", () => {
    const raw = withBlock({
      exercises: [
        { name: "ランニング", durationMin: 20 },
        { name: "スクワット", sets: [{ weight: 80, reps: 5 }], intensity: "hard" },
      ],
    });
    const { payload } = parseWorkoutPlanReply(raw);
    expect(payload?.exercises[0]).toEqual({ name: "ランニング", durationMin: 20 });
    expect(payload?.exercises[1].intensity).toBe("hard");
  });

  it("defaults mode to 'new' and keeps 'correct' when set", () => {
    const def = withBlock({ exercises: [{ name: "腹筋", sets: [{ reps: 20 }] }] });
    expect(parseWorkoutPlanReply(def).payload?.mode).toBe("new");
    const corr = withBlock({ exercises: [{ name: "腹筋", sets: [{ reps: 25 }] }], mode: "correct" });
    expect(parseWorkoutPlanReply(corr).payload?.mode).toBe("correct");
  });

  it("never shows raw JSON even when MALFORMED (strips, no plan)", () => {
    const raw = `入れておきました。\n${WORKOUT_PLAN_OPEN}{"exercises": [oops${WORKOUT_PLAN_CLOSE}`;
    const { display, payload } = parseWorkoutPlanReply(raw);
    expect(display).toBe("入れておきました。");
    expect(display).not.toContain(WORKOUT_PLAN_OPEN);
    expect(payload).toBeNull();
  });

  it("returns null payload when the block has zero usable exercises", () => {
    const raw = withBlock({ exercises: [{ name: "", sets: [] }] });
    expect(parseWorkoutPlanReply(raw).payload).toBeNull();
  });

  it("returns trimmed text + null payload when there is no block", () => {
    const { display, payload } = parseWorkoutPlanReply("  何時から始めますか？  ");
    expect(display).toBe("何時から始めますか？");
    expect(payload).toBeNull();
  });
});

describe("hasWorkoutPlanBlock", () => {
  it("detects a present block (even malformed) and reports absence", () => {
    expect(hasWorkoutPlanBlock(withBlock({ exercises: [{ name: "腹筋", sets: [{ reps: 20 }] }] }))).toBe(true);
    expect(hasWorkoutPlanBlock(`${WORKOUT_PLAN_OPEN}garbage${WORKOUT_PLAN_CLOSE}`)).toBe(true);
    expect(hasWorkoutPlanBlock("ふつうの返信です")).toBe(false);
  });
});

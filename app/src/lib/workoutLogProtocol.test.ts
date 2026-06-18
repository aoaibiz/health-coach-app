import { describe, it, expect } from "vitest";
import {
  WORKOUT_LOG_OPEN,
  WORKOUT_LOG_CLOSE,
  hasWorkoutLogBlock,
  parseWorkoutReply,
} from "./workoutLogProtocol";

/** Wrap a JSON object in the workout sentinel block, with optional prose. */
function withBlock(json: unknown, prose = "筋トレを記録しておきました。"): string {
  return `${prose}\n${WORKOUT_LOG_OPEN}${JSON.stringify(json)}${WORKOUT_LOG_CLOSE}`;
}

describe("parseWorkoutReply — strips the workout block, keeps natural prose", () => {
  it("parses a valid strength block and removes it from the displayed text", () => {
    const raw = withBlock({
      exercises: [
        { name: "ベンチプレス", sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }] },
        { name: "腹筋", sets: [{ reps: 20 }] },
      ],
      mode: "new",
    });
    const { display, payload } = parseWorkoutReply(raw);

    // The user sees ONLY natural prose — never the JSON or the sentinels.
    expect(display).toBe("筋トレを記録しておきました。");
    expect(display).not.toContain(WORKOUT_LOG_OPEN);
    expect(display).not.toContain("exercises");
    expect(display).not.toContain("weight");

    expect(payload).not.toBeNull();
    expect(payload?.exercises).toHaveLength(2);
    expect(payload?.exercises[0]).toEqual({
      name: "ベンチプレス",
      sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }],
    });
    // 自重 (no weight) parses with reps only.
    expect(payload?.exercises[1]).toEqual({ name: "腹筋", sets: [{ reps: 20 }] });
    expect(payload?.mode).toBe("new");
  });

  it("parses a cardio block (durationMin, no sets)", () => {
    const raw = withBlock({ exercises: [{ name: "ランニング", durationMin: 20 }] });
    const { payload } = parseWorkoutReply(raw);
    expect(payload?.exercises[0]).toEqual({ name: "ランニング", durationMin: 20 });
  });

  it("defaults mode to 'new' when omitted (never silently corrects)", () => {
    const raw = withBlock({ exercises: [{ name: "腹筋", sets: [{ reps: 20 }] }] });
    expect(parseWorkoutReply(raw).payload?.mode).toBe("new");
  });

  it("keeps mode 'correct' when the model sets it", () => {
    const raw = withBlock({ exercises: [{ name: "腹筋", sets: [{ reps: 25 }] }], mode: "correct" });
    expect(parseWorkoutReply(raw).payload?.mode).toBe("correct");
  });

  it("parses intensity when valid, ignores garbage", () => {
    const ok = withBlock({ exercises: [{ name: "スクワット", sets: [{ weight: 80, reps: 5 }], intensity: "hard" }] });
    expect(parseWorkoutReply(ok).payload?.exercises[0].intensity).toBe("hard");
    const bad = withBlock({ exercises: [{ name: "スクワット", sets: [{ reps: 5 }], intensity: "ものすごく" }] });
    expect(parseWorkoutReply(bad).payload?.exercises[0].intensity).toBeUndefined();
  });

  it("never shows raw JSON even when MALFORMED (strips, no log)", () => {
    const raw = `記録しました。\n${WORKOUT_LOG_OPEN}{"exercises": [oops${WORKOUT_LOG_CLOSE}`;
    const { display, payload } = parseWorkoutReply(raw);
    expect(display).toBe("記録しました。");
    expect(display).not.toContain(WORKOUT_LOG_OPEN);
    expect(display).not.toContain("exercises");
    expect(payload).toBeNull();
  });

  it("tolerates an inner ```json fence", () => {
    const inner = "```json\n" + JSON.stringify({ exercises: [{ name: "懸垂", sets: [{ reps: 8 }] }] }) + "\n```";
    const raw = `${WORKOUT_LOG_OPEN}${inner}${WORKOUT_LOG_CLOSE}`;
    expect(parseWorkoutReply(raw).payload?.exercises[0]).toEqual({ name: "懸垂", sets: [{ reps: 8 }] });
  });

  it("drops exercises with no name or no effort (no sets and no duration)", () => {
    const raw = withBlock({
      exercises: [
        { name: "ベンチ", sets: [{ weight: 60, reps: 10 }] },
        { name: "", sets: [{ reps: 10 }] }, // no name → dropped
        { name: "謎運動" }, // no sets, no duration → dropped
        { name: "ゼロセット", sets: [{ reps: 0 }] }, // set with 0 reps → no valid set → dropped
      ],
    });
    const { payload } = parseWorkoutReply(raw);
    expect(payload?.exercises).toEqual([{ name: "ベンチ", sets: [{ weight: 60, reps: 10 }] }]);
  });

  it("returns null payload when the block has zero usable exercises", () => {
    const raw = withBlock({ exercises: [{ name: "", sets: [] }] });
    const { payload, display } = parseWorkoutReply(raw);
    expect(payload).toBeNull();
    expect(display).not.toContain("exercises");
  });

  it("returns trimmed text + null payload when there is no block", () => {
    const { display, payload } = parseWorkoutReply("  何セットやりましたか？  ");
    expect(display).toBe("何セットやりましたか？");
    expect(payload).toBeNull();
  });
});

describe("hasWorkoutLogBlock", () => {
  it("detects a present block (even malformed) and reports absence", () => {
    expect(hasWorkoutLogBlock(withBlock({ exercises: [{ name: "腹筋", sets: [{ reps: 20 }] }] }))).toBe(true);
    expect(hasWorkoutLogBlock(`${WORKOUT_LOG_OPEN}garbage${WORKOUT_LOG_CLOSE}`)).toBe(true);
    expect(hasWorkoutLogBlock("ふつうの返信です")).toBe(false);
  });
});

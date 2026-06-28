import { describe, expect, it } from "vitest";
import {
  deleteConfirmation,
  resolveChatDeleteRequest,
  resolveDeleteRequestFromCoachReply,
  resolveDeleteRecordAction,
} from "./chatDeleteIntent";
import {
  DELETE_RECORD_CLOSE,
  DELETE_RECORD_OPEN,
} from "./deleteRecordProtocol";
import type { ChatMessage } from "./chatStore";
import type { Meal, Workout } from "./types";

const NOW = new Date(2026, 5, 28, 0, 30); // local 2026-06-28

function meal(id: string, date: string, text = `meal ${id}`): Meal {
  return {
    id,
    date,
    timestamp: `${date}T12:00:00.000Z`,
    type: "昼",
    text,
  };
}

function assistantLoggedMeal(mealId: string): ChatMessage {
  return {
    id: `m-${mealId}`,
    role: "assistant",
    content: "食事に記録しました。",
    createdAt: "2026-06-28T00:00:00.000Z",
    loggedMeal: { mealId, itemCount: 1 },
  };
}

function assistantLoggedWorkout(date: string, exerciseIds: string[]): ChatMessage {
  return {
    id: `w-${date}`,
    role: "assistant",
    content: "筋トレを記録しました。",
    createdAt: "2026-06-28T00:00:00.000Z",
    loggedWorkout: { date, exerciseIds, exerciseCount: exerciseIds.length },
  };
}

describe("resolveChatDeleteRequest", () => {
  it("deletes only the latest chat-logged meal for the named day (duplicate fix), not every meal that day", () => {
    const meals = [
      meal("morning", "2026-06-28", "朝食"),
      meal("dup", "2026-06-28", "重複した昼食"),
      meal("yesterday", "2026-06-27", "昨日の食事"),
    ];
    const messages = [assistantLoggedMeal("dup")];

    const request = resolveChatDeleteRequest("重複してるから今日の分消しといて", {
      messages,
      meals,
      workouts: {},
      now: NOW,
    });

    expect(request).toEqual({
      kind: "meal",
      scope: "last",
      date: "2026-06-28",
      ids: ["dup"],
      count: 1,
    });
  });

  it("does not delete a recent meal when the user named a different day", () => {
    const meals = [meal("today", "2026-06-28")];
    const request = resolveChatDeleteRequest("昨日の分消しといて", {
      messages: [assistantLoggedMeal("today")],
      meals,
      workouts: {},
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("does not auto-delete when the delete instruction mentions conflicting days", () => {
    const meals = [meal("today", "2026-06-28"), meal("yesterday", "2026-06-27")];
    const request = resolveChatDeleteRequest("昨日じゃなく今日の食事を全部削除して", {
      messages: [],
      meals,
      workouts: {},
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("does not fall back to the latest record when a non-all delete instruction mentions conflicting days", () => {
    const meals = [meal("today", "2026-06-28"), meal("yesterday", "2026-06-27")];
    const request = resolveChatDeleteRequest("昨日じゃなく今日の分消しといて", {
      messages: [assistantLoggedMeal("today")],
      meals,
      workouts: {},
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("does not auto-delete a mixed meal-and-workout request as a partial delete", () => {
    const request = resolveChatDeleteRequest("今日の食事と筋トレを全部削除して", {
      messages: [assistantLoggedMeal("today")],
      meals: [meal("today", "2026-06-28")],
      workouts: {
        "2026-06-28": {
          date: "2026-06-28",
          updatedAt: "2026-06-28T12:00:00.000Z",
          exercises: [{ id: "bench", name: "ベンチ", sets: 3, reps: 10, weight: 60 }],
        },
      },
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("does not treat an ambiguous no-kind cancellation as a health-record delete", () => {
    const request = resolveChatDeleteRequest("それ取り消して", {
      messages: [assistantLoggedMeal("today")],
      meals: [meal("today", "2026-06-28")],
      workouts: {},
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("does not bulk-delete when an all-day phrase is negated", () => {
    const meals = [meal("a", "2026-06-28"), meal("b", "2026-06-28")];
    const request = resolveChatDeleteRequest("全部じゃなくて今日の食事を消して", {
      messages: [assistantLoggedMeal("b")],
      meals,
      workouts: {},
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("does not bulk-delete when the negated all phrase includes words before the negation", () => {
    const meals = [meal("a", "2026-06-28"), meal("b", "2026-06-28")];
    const request = resolveChatDeleteRequest("全部消してじゃなくて今日の食事を消して", {
      messages: [assistantLoggedMeal("b")],
      meals,
      workouts: {},
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("does not bulk-delete a latest inferred kind when the all-day request omits meal/workout kind", () => {
    const meals = [meal("a", "2026-06-28"), meal("b", "2026-06-28")];
    const request = resolveChatDeleteRequest("今日の記録を全部削除して", {
      messages: [assistantLoggedMeal("b")],
      meals,
      workouts: {},
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("allows explicit all-meals deletion for a named day only when the user says all", () => {
    const meals = [
      meal("a", "2026-06-28"),
      meal("b", "2026-06-28"),
      meal("c", "2026-06-27"),
    ];

    const request = resolveChatDeleteRequest("今日の食事を全部削除して", {
      messages: [],
      meals,
      workouts: {},
      now: NOW,
    });

    expect(request).toEqual({
      kind: "meal",
      scope: "date",
      date: "2026-06-28",
      ids: ["a", "b"],
      count: 2,
    });
  });

  it("deletes the latest chat-logged workout batch when the text targets workouts", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T12:00:00.000Z",
        exercises: [
          { id: "bench", name: "ベンチ", sets: 3, reps: 10, weight: 60 },
          { id: "squat", name: "スクワット", sets: 3, reps: 10, weight: 80 },
          { id: "keep", name: "腹筋", sets: 3, reps: 20, weight: 0 },
        ],
      },
    };

    const request = resolveChatDeleteRequest("今日の筋トレの重複を消して", {
      messages: [assistantLoggedWorkout("2026-06-28", ["bench", "squat"])],
      meals: [],
      workouts,
      now: NOW,
    });

    expect(request).toEqual({
      kind: "workout",
      scope: "last",
      date: "2026-06-28",
      ids: ["bench", "squat"],
      count: 2,
    });
  });

  it("deletes the latest chat-logged workout batch even when a meal was logged after it", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T12:00:00.000Z",
        exercises: [
          { id: "bench", name: "ベンチ", sets: 3, reps: 10, weight: 60 },
          { id: "squat", name: "スクワット", sets: 3, reps: 10, weight: 80 },
          { id: "keep", name: "腹筋", sets: 3, reps: 20, weight: 0 },
        ],
      },
    };

    const request = resolveChatDeleteRequest("今日の筋トレの重複を消して", {
      messages: [
        assistantLoggedWorkout("2026-06-28", ["bench", "squat"]),
        assistantLoggedMeal("later-meal"),
      ],
      meals: [meal("later-meal", "2026-06-28")],
      workouts,
      now: NOW,
    });

    expect(request).toEqual({
      kind: "workout",
      scope: "last",
      date: "2026-06-28",
      ids: ["bench", "squat"],
      count: 2,
    });
  });

  it("deletes today's explicit workout request even without chat log metadata", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const request = resolveChatDeleteRequest("今日の運動消しといて！", {
      messages: [],
      meals: [],
      workouts,
      now: NOW,
    });

    expect(request).toEqual({
      kind: "workout",
      scope: "date",
      date: "2026-06-28",
      ids: ["hang", "squat"],
      count: 2,
    });
  });

  it("does not broaden a named exercise natural-language delete into a whole-day workout delete", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const request = resolveChatDeleteRequest("今日の懸垂だけ消して", {
      messages: [],
      meals: [],
      workouts,
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("does not turn a named exercise natural-language delete into the latest workout batch", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const request = resolveChatDeleteRequest("今日の懸垂だけ消して", {
      messages: [assistantLoggedWorkout("2026-06-28", ["squat"])],
      meals: [],
      workouts,
      now: NOW,
    });

    expect(request).toBeNull();
  });

  it("uses the previous assistant deletion target when the user says to do it", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };
    const messages: ChatMessage[] = [
      {
        id: "assistant-delete-target",
        role: "assistant",
        content: "削除対象は「今日の運動」、つまり今日 01:31 に入っている筋トレ記録です。",
        createdAt: "2026-06-28T01:32:00.000Z",
      },
    ];

    const request = resolveChatDeleteRequest("お前が消せよ", {
      messages,
      meals: [],
      workouts,
      now: NOW,
    });

    expect(request).toEqual({
      kind: "workout",
      scope: "date",
      date: "2026-06-28",
      ids: ["hang", "squat"],
      count: 2,
    });
  });

  it("ignores a delete-ish question that is not an instruction", () => {
    const request = resolveChatDeleteRequest("記録って削除できますか？", {
      messages: [assistantLoggedMeal("x")],
      meals: [meal("x", "2026-06-28")],
      workouts: {},
      now: NOW,
    });

    expect(request).toBeNull();
  });
});

describe("resolveDeleteRecordAction", () => {
  it("turns an LLM-decided day workout delete action into all exercises for that day", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const request = resolveDeleteRecordAction(
      { kind: "workout", date: "2026-06-28", scope: "day" },
      { messages: [], meals: [], workouts },
    );

    expect(request).toEqual({
      kind: "workout",
      scope: "date",
      date: "2026-06-28",
      ids: ["hang", "squat"],
      count: 2,
    });
  });

  it("uses names from the LLM action to delete only matching workout exercises", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const request = resolveDeleteRecordAction(
      { kind: "workout", date: "2026-06-28", scope: "day", names: ["懸垂"] },
      { messages: [], meals: [], workouts },
    );

    expect(request).toEqual({
      kind: "workout",
      scope: "last",
      date: "2026-06-28",
      ids: ["hang"],
      count: 1,
    });
  });

  it("does not broaden an unmatched named workout action into a whole-day delete", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const request = resolveDeleteRecordAction(
      { kind: "workout", date: "2026-06-28", scope: "day", names: ["ベンチプレス"] },
      { messages: [], meals: [], workouts },
    );

    expect(request).toBeNull();
  });

  it("does not broaden an unmatched named meal action into a whole-day delete", () => {
    const meals = [
      meal("lunch", "2026-06-28", "鶏むね肉"),
      meal("snack", "2026-06-28", "プロテイン"),
    ];

    const request = resolveDeleteRecordAction(
      { kind: "meal", date: "2026-06-28", scope: "day", names: ["朝食"] },
      { messages: [], meals, workouts: {} },
    );

    expect(request).toBeNull();
  });

  it("uses chat log metadata for a structured latest meal delete", () => {
    const meals = [
      meal("older", "2026-06-28", "朝食"),
      meal("chat-logged", "2026-06-28", "昼食"),
    ];

    const request = resolveDeleteRecordAction(
      { kind: "meal", date: "2026-06-28", scope: "latest" },
      { messages: [assistantLoggedMeal("chat-logged")], meals, workouts: {} },
    );

    expect(request).toEqual({
      kind: "meal",
      scope: "last",
      date: "2026-06-28",
      ids: ["chat-logged"],
      count: 1,
    });
  });

  it("does not turn a structured latest meal action without chat metadata into a newest-meal delete", () => {
    const meals = [
      meal("older", "2026-06-28", "朝食"),
      meal("newest", "2026-06-28", "昼食"),
    ];

    const request = resolveDeleteRecordAction(
      { kind: "meal", date: "2026-06-28", scope: "latest" },
      { messages: [], meals, workouts: {} },
    );

    expect(request).toBeNull();
  });

  it("does not turn a latest workout action without chat metadata or names into a whole-day delete", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const request = resolveDeleteRecordAction(
      { kind: "workout", date: "2026-06-28", scope: "latest" },
      { messages: [], meals: [], workouts },
    );

    expect(request).toBeNull();
  });
});

describe("resolveDeleteRequestFromCoachReply", () => {
  it("does not fall back to natural-language deletion when an invalid structured block was present", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const result = resolveDeleteRequestFromCoachReply(
      `確認します。${DELETE_RECORD_OPEN}{"kind":"workout","date":"今日","scope":"day"}${DELETE_RECORD_CLOSE}`,
      "今日の運動消して",
      { messages: [], meals: [], workouts, now: NOW },
    );

    expect(result).toEqual({
      display: "確認します。",
      request: null,
      handled: true,
    });
  });

  it("does not leak orphan delete JSON or fall back when only a close marker is present", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const result = resolveDeleteRequestFromCoachReply(
      `確認します。{"kind":"workout","date":"2026-06-28","scope":"day"}${DELETE_RECORD_CLOSE}`,
      "今日の運動消して",
      { messages: [], meals: [], workouts, now: NOW },
    );

    expect(result).toEqual({
      display: "確認します。",
      request: null,
      handled: true,
    });
  });

  it("still uses natural-language fallback when no structured delete block is present", () => {
    const workouts: Record<string, Workout> = {
      "2026-06-28": {
        date: "2026-06-28",
        updatedAt: "2026-06-28T01:31:00.000Z",
        exercises: [
          { id: "hang", name: "懸垂", sets: 3, reps: 5, weight: 0 },
          { id: "squat", name: "ブルガリアンスクワット", sets: 3, reps: 10, weight: 0 },
        ],
      },
    };

    const result = resolveDeleteRequestFromCoachReply(
      "今日の運動記録ですね。",
      "今日の運動消して",
      { messages: [], meals: [], workouts, now: NOW },
    );

    expect(result).toEqual({
      display: "今日の運動記録ですね。",
      request: {
        kind: "workout",
        scope: "date",
        date: "2026-06-28",
        ids: ["hang", "squat"],
        count: 2,
      },
      handled: true,
    });
  });
});

describe("deleteConfirmation", () => {
  it("states the concrete date and what was deleted", () => {
    expect(
      deleteConfirmation({
        kind: "meal",
        scope: "last",
        date: "2026-06-28",
        ids: ["dup"],
        count: 1,
      }),
    ).toContain("2026-06-28 の食事記録を1件削除しました");
  });
});

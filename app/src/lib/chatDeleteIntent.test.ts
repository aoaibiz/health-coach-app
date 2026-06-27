import { describe, expect, it } from "vitest";
import {
  deleteConfirmation,
  resolveChatDeleteRequest,
} from "./chatDeleteIntent";
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

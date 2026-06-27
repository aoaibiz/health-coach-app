import { shiftDateKey, toDateKey } from "./date";
import type { ChatMessage } from "./chatStore";
import type { Meal, Workout } from "./types";

export type ChatDeleteKind = "meal" | "workout";
export type ChatDeleteScope = "last" | "date";

export interface ChatDeleteRequest {
  kind: ChatDeleteKind;
  scope: ChatDeleteScope;
  date: string;
  ids: string[];
  count: number;
}

interface LatestLoggedAction {
  kind: ChatDeleteKind;
  ids: string[];
  date?: string;
}

interface DeleteDateResolution {
  dateKey: string | null;
  ambiguous: boolean;
}

const DELETE_INSTRUCTION_RE =
  /(消しといて|消しておいて|消して|消せ|削除して|削除しといて|取り消して|取消して|なかったことにして)/;
const DELETE_QUESTION_RE = /(削除|消す|消し).*(できますか|できる\?|できる？|可能ですか|可能？)/;
const ALL_RE = /全部|全て|すべて|全件|一括|まとめて/;
const NEGATED_ALL_RE =
  /(全部|全て|すべて|全件|一括|まとめて)[^、。,.，．!?！？]{0,12}(?:じゃなく|じゃない|ではなく|ではない|でなく|じゃなくて)/;
const LATEST_RECORD_FALLBACK_RE = /記録|重複|直近|最新|最後|今の|この記録|この分|さっき|先ほど/;

const MEAL_RE = /食事|ごはん|ご飯|朝食|昼食|夕食|夜食|間食|おやつ|メニュー|献立|食べ|飲み|飲ん/;
const WORKOUT_RE =
  /筋トレ|運動|トレーニング|ワークアウト|種目|セット|レップ|ベンチ|スクワット|デッドリフト|腹筋|腕立て|懸垂|ランニング|ジョギング|ウォーキング|有酸素/;

const DAY_MARKERS: Array<{ re: RegExp; offset: number }> = [
  { re: /一昨昨日|一昨々日|さきおととい/, offset: -3 },
  { re: /一昨日|おととい|おとつい/, offset: -2 },
  { re: /昨日|きのう|キノウ|前日/, offset: -1 },
  { re: /今日|きょう|本日/, offset: 0 },
];

function resolveDeleteDate(text: string, now: Date): DeleteDateResolution {
  const today = toDateKey(now);
  const spans: Array<{ start: number; end: number; offset: number }> = [];
  for (const { re, offset } of DAY_MARKERS) {
    const g = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      const overlaps = spans.some((s) => start < s.end && end > s.start);
      if (!overlaps) spans.push({ start, end, offset });
      if (m.index === g.lastIndex) g.lastIndex++;
    }
  }
  const offsets = new Set(spans.map((s) => s.offset));
  if (offsets.size === 0) return { dateKey: null, ambiguous: false };
  if (offsets.size > 1) return { dateKey: null, ambiguous: true };
  return { dateKey: shiftDateKey(today, [...offsets][0]), ambiguous: false };
}

function latestLoggedAction(
  messages: ReadonlyArray<ChatMessage>,
  kind?: ChatDeleteKind,
): LatestLoggedAction | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    if ((!kind || kind === "meal") && msg.loggedMeal?.mealId) {
      return { kind: "meal", ids: [msg.loggedMeal.mealId] };
    }
    if ((!kind || kind === "workout") && msg.loggedWorkout?.exerciseIds?.length) {
      return {
        kind: "workout",
        ids: msg.loggedWorkout.exerciseIds,
        date: msg.loggedWorkout.date,
      };
    }
  }
  return null;
}

function requestedKind(text: string, latest: LatestLoggedAction | null): ChatDeleteKind | null {
  const explicit = explicitlyRequestedKind(text);
  if (explicit) return explicit;
  if (mentionsBothKinds(text)) return null;
  return latest && canFallbackToLatestRecord(text) ? latest.kind : null;
}

function explicitlyRequestedKind(text: string): ChatDeleteKind | null {
  const meal = MEAL_RE.test(text);
  const workout = WORKOUT_RE.test(text);
  if (meal && !workout) return "meal";
  if (workout && !meal) return "workout";
  return null;
}

function mentionsBothKinds(text: string): boolean {
  return MEAL_RE.test(text) && WORKOUT_RE.test(text);
}

function hasDayMarker(text: string): boolean {
  return DAY_MARKERS.some(({ re }) => new RegExp(re.source).test(text));
}

function canFallbackToLatestRecord(text: string): boolean {
  return LATEST_RECORD_FALLBACK_RE.test(text) || hasDayMarker(text);
}

function mealDate(meals: Meal[], id: string): string | null {
  return meals.find((m) => m.id === id)?.date ?? null;
}

function workoutIdsOnDate(
  workouts: Record<string, Workout>,
  date: string,
  ids: ReadonlyArray<string>,
): string[] {
  const present = new Set((workouts[date]?.exercises ?? []).map((e) => e.id));
  return ids.filter((id) => present.has(id));
}

export function resolveChatDeleteRequest(
  text: string,
  opts: {
    messages: ReadonlyArray<ChatMessage>;
    meals: Meal[];
    workouts: Record<string, Workout>;
    now?: Date;
  },
): ChatDeleteRequest | null {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return null;
  if (DELETE_QUESTION_RE.test(t)) return null;
  if (!DELETE_INSTRUCTION_RE.test(t)) return null;

  const now = opts.now ?? new Date();
  const resolvedDate = resolveDeleteDate(t, now);
  if (resolvedDate.ambiguous) return null;
  const targetDate = resolvedDate.dateKey;
  const latestAny = latestLoggedAction(opts.messages);
  const kind = requestedKind(t, latestAny);
  if (!kind) return null;
  const latest = latestLoggedAction(opts.messages, kind);

  if (NEGATED_ALL_RE.test(t)) return null;
  const wantsAll = ALL_RE.test(t);
  if (wantsAll) {
    if (!explicitlyRequestedKind(t)) return null;
    if (!targetDate) return null;
    if (kind === "meal") {
      const ids = opts.meals.filter((m) => m.date === targetDate).map((m) => m.id);
      return ids.length > 0
        ? { kind, scope: "date", date: targetDate, ids, count: ids.length }
        : null;
    }
    const ids = (opts.workouts[targetDate]?.exercises ?? []).map((e) => e.id);
    return ids.length > 0
      ? { kind, scope: "date", date: targetDate, ids, count: ids.length }
      : null;
  }

  if (!latest || latest.kind !== kind) return null;

  if (kind === "meal") {
    const id = latest.ids[0];
    const date = mealDate(opts.meals, id);
    if (!date) return null;
    if (targetDate && targetDate !== date) return null;
    return { kind, scope: "last", date, ids: [id], count: 1 };
  }

  const date = latest.date ?? targetDate;
  if (!date) return null;
  if (targetDate && targetDate !== date) return null;
  const ids = workoutIdsOnDate(opts.workouts, date, latest.ids);
  return ids.length > 0 ? { kind, scope: "last", date, ids, count: ids.length } : null;
}

export function deleteConfirmation(request: ChatDeleteRequest): string {
  const label = request.kind === "meal" ? "食事記録" : "運動記録";
  const scope =
    request.scope === "date"
      ? `${request.date} の${label}を${request.count}件削除しました。`
      : `${request.date} の${label}を${request.count}件削除しました。`;
  return `${scope}\n\n別の日や別の記録を消したい場合は、「昨日の食事を全部削除」のように日付と種類を指定してください。`;
}

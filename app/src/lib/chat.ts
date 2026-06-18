// Client-side bridge to POST /api/chat (Phase 5) + the pure context builder.
//
// All user data is client-side, so the client sends the recent conversation +
// a small "context" object (goal, target kcal/PFC, today's intake/burn totals)
// the coach can ground its numbers on. The token gate mirrors analyzeMeal.ts:
// we attach X-Health-App-Token from localStorage when present.
//
// On failure this throws an honest error — the UI keeps the conversation and
// lets the user retry. It never fabricates a reply.

import { API_TOKEN_STORAGE_KEY } from "./analyzeMeal";
import { activityLabel, bodyTypeLabel, goalLabel, sexLabel } from "./profileView";
import { clampGrams, clampQty } from "./mealItems";
import { isWeightedExercise } from "./burn";
import { setsFor, summarizeSets } from "./workoutSets";
import type { IntakeTotals } from "./intake";
import type { Exercise, Meal, NutritionTargets, Profile } from "./types";

/** One grounded item from a photo analysis, forwarded so the coach can narrate it. */
export interface ChatMealAnalysisItem {
  name: string;
  grams: number;
  kcal: number | null;
  proteinG?: number | null;
  fatG?: number | null;
  carbG?: number | null;
  sourceLabel?: string | null;
  sourceKind?: "db" | "label" | "estimate" | null;
}

/** Grounded photo-analysis attached to the photo turn (chat→食事 flow). */
export interface ChatMealAnalysis {
  /** false = the photo wasn't analysable as food (coach handles gracefully). */
  ok: boolean;
  items?: ChatMealAnalysisItem[];
  estimated?: boolean;
}

/** One of today's logged meals reduced to slot + local HH:MM (meal spacing). */
export interface LoggedMealTime {
  type: string;
  time: string;
}

/**
 * One of today's logged meals reduced to its slot + the list of WHAT was eaten
 * (item names, each with grams + optional qty), so the coach knows the actual
 * content — not just the time/totals — and can confirm + coach on it. Only the
 * user's OWN logged items; sanitised + capped before they reach the prompt.
 */
export interface LoggedMealContent {
  type: string;
  /** Item names + portion (e.g. "ごはん150g", "卵50g×2"), already capped/sanitised. */
  items: string[];
}

/** The user-chosen coach persona that travels to the prompt (presentation only). */
export interface ChatCoachPersona {
  name?: string;
  gender?: "female" | "male" | "unspecified";
  style?: "gentle" | "hardcore" | "logical" | "friendly";
}

/**
 * The user's OWN registered身体情報 forwarded to their own coach (mirrors the
 * backend RegisteredProfile). Every field optional: only what the user actually
 * registered is set (unset → omitted, never invented). Numbers are clamped to
 * sane ranges and labels sanitised to a single safe line before they leave.
 */
export interface ChatRegisteredProfile {
  heightCm?: number;
  weightKg?: number;
  targetWeightKg?: number;
  age?: number;
  sexLabel?: string;
  bodyTypeLabel?: string;
  activityLabel?: string;
  goalLabel?: string;
  bodyFatPct?: number;
}

/** Minimal day snapshot sent to the coach (mirrors the backend ChatContext). */
export interface ChatContext {
  /** User-chosen coach persona (name/gender/style) — presentation only. */
  coach?: ChatCoachPersona;
  /** The user's OWN registered身体情報 (height/weight/age/...) — own data → own coach. */
  registered?: ChatRegisteredProfile;
  /** Current local date+time, pre-formatted from the device clock (e.g. "2026-06-18(火) 08:10"). */
  nowText?: string;
  /** Times of today's actually-logged meals (slot + local HH:MM). */
  loggedMeals?: LoggedMealTime[];
  /** Local time today's workout was logged (HH:MM), when any exercise was logged today. */
  loggedWorkoutTime?: string;
  /** WHAT was logged today per meal slot (item names + portions) — own logged data. */
  loggedMealItems?: LoggedMealContent[];
  /** WHAT exercises were logged today (name + compact set summary) — own logged data. */
  loggedWorkoutItems?: string[];
  goal?: string;
  targetKcal?: number;
  targetProteinG?: number;
  targetFatG?: number;
  targetCarbG?: number;
  intakeKcal?: number;
  intakeProteinG?: number;
  intakeFatG?: number;
  intakeCarbG?: number;
  burnKcal?: number;
  name?: string;
  /** Grounded result of a photo the user sent THIS turn. Only set on a photo turn. */
  mealAnalysis?: ChatMealAnalysis;
}

export interface ChatWireMessage {
  role: "user" | "assistant";
  content: string;
}

/** Strip a string to a single safe line (remove control chars incl. \n\r\t) +
 *  trim. Mirrors the server sanitizeLine so a label can't carry an injected
 *  heading onto its own line. */
function sanitizeLine(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "").trim();
}

/** Clamp a numeric profile field to a sane non-negative range; non-finite /
 *  negative / unset → undefined (omitted, never fabricated). */
function clampNum(v: number | undefined, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return v > max ? max : v;
}

// Sane human-body clamps (match the server shapeRegistered ranges).
const MAX_HEIGHT_CM = 300;
const MAX_WEIGHT_KG = 700;
const MAX_AGE = 150;
const MAX_BODY_FAT_PCT = 100;

/**
 * Reduce a Profile to the registered身体情報 the coach is handed — only the
 * fields the user actually set (unset → omitted, NEVER invented). Numbers are
 * clamped to sane ranges and the categorical labels are localised + sanitised to
 * a single safe line. The display NAME is carried separately (ctx.name). Returns
 * undefined when nothing usable is set so the context omits the block.
 */
export function buildRegisteredProfile(
  profile: Profile | null,
): ChatRegisteredProfile | undefined {
  if (!profile) return undefined;
  const out: ChatRegisteredProfile = {};

  const heightCm = clampNum(profile.heightCm, MAX_HEIGHT_CM);
  if (heightCm !== undefined) out.heightCm = heightCm;
  const weightKg = clampNum(profile.weightKg, MAX_WEIGHT_KG);
  if (weightKg !== undefined) out.weightKg = weightKg;
  const targetWeightKg = clampNum(profile.targetWeightKg, MAX_WEIGHT_KG);
  if (targetWeightKg !== undefined) out.targetWeightKg = targetWeightKg;
  const age = clampNum(profile.age, MAX_AGE);
  if (age !== undefined) out.age = age;
  const bodyFatPct = clampNum(profile.bodyFatPct, MAX_BODY_FAT_PCT);
  if (bodyFatPct !== undefined) out.bodyFatPct = bodyFatPct;

  if (profile.sex) {
    const s = sanitizeLine(sexLabel(profile.sex));
    if (s) out.sexLabel = s;
  }
  if (profile.bodyType) {
    const b = sanitizeLine(bodyTypeLabel(profile.bodyType));
    if (b) out.bodyTypeLabel = b;
  }
  if (profile.activityLevel) {
    const a = sanitizeLine(activityLabel(profile.activityLevel));
    if (a) out.activityLabel = a;
  }
  if (profile.goal) {
    const g = sanitizeLine(goalLabel(profile.goal));
    if (g) out.goalLabel = g;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// ---- Logged-content collection (WHAT was eaten / done today) ----------------
// The coach already gets totals + timings + profile; these helpers add the
// actual logged CONTENT so it can confirm + coach on it ("今日は鶏むね肉とごはん
// を食べてますね"). Pure + bounded: each name is sanitised to a single safe line
// and length-clamped, numbers clamp to sane ranges, and the number of items is
// CAPPED (+"他N件") so the user's own data can never balloon or be used to inject.
// Nothing is invented — only what's actually in the store is rendered; an empty
// day yields undefined so the context omits the block entirely.

/** Max chars for a single item/exercise name once single-lined. */
const MAX_ITEM_NAME_CHARS = 40;
/** Cap on items rendered PER meal slot (excess → "他N件"). */
const MAX_ITEMS_PER_MEAL = 12;
/** Cap on exercises rendered (excess → "他N件"). */
const MAX_WORKOUT_ITEMS = 12;
/** Sane portion clamp for the rendered grams (mirrors mealItems clampGrams cap). */

/** Strip + single-line + length-clamp an item/exercise name. "" → caller drops. */
function cleanName(name: string | undefined): string {
  if (typeof name !== "string") return "";
  return sanitizeLine(name).slice(0, MAX_ITEM_NAME_CHARS);
}

/**
 * Render ONE meal item as "name + portion": grams from the effective per-unit
 * grams (clamped), and "×qty" only when qty > 1. Returns "" when the item has no
 * usable name (caller drops it) — never fabricates a portion.
 */
function formatMealItemLine(item: {
  name?: string;
  grams?: number;
  qty?: number;
}): string {
  const name = cleanName(item.name);
  if (!name) return "";
  const grams = clampGrams(typeof item.grams === "number" ? item.grams : 0);
  const qty = clampQty(typeof item.qty === "number" ? item.qty : 1);
  const portion = grams > 0 ? `${Math.round(grams)}g` : "";
  const qtyPart = qty > 1 ? `×${Math.round(qty)}` : "";
  return `${name}${portion}${qtyPart}`;
}

/**
 * Collect WHAT was logged today, grouped by meal slot. Only meals carrying a
 * per-item breakdown contribute content (the only place item NAMES exist — a
 * plain manual total has no names to show, so it's omitted rather than invented).
 * Each slot's items are sanitised + capped at MAX_ITEMS_PER_MEAL (+"他N件").
 * Returns undefined when nothing usable, so the context omits the block.
 */
export function buildLoggedMealItems(meals: Meal[]): LoggedMealContent[] | undefined {
  const out: LoggedMealContent[] = [];
  for (const meal of meals) {
    const rawItems = meal?.nutrition?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) continue;
    const lines: string[] = [];
    for (const it of rawItems) {
      const line = formatMealItemLine(it);
      if (line) lines.push(line);
    }
    if (lines.length === 0) continue;
    const shown =
      lines.length > MAX_ITEMS_PER_MEAL
        ? [...lines.slice(0, MAX_ITEMS_PER_MEAL), `他${lines.length - MAX_ITEMS_PER_MEAL}件`]
        : lines;
    out.push({ type: meal.type, items: shown });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Collect WHAT exercises were logged today as compact "name + set summary" lines
 * (e.g. "ベンチプレス 60kg×10 ×3セット", "スクワット ×15 ×2セット"). Reuses the
 * EXISTING workout helpers (summarizeSets + the bodyweight decision) so the
 * rendering matches the 筋トレ screen and never invents a number. Sanitised +
 * capped at MAX_WORKOUT_ITEMS (+"他N件"). Returns undefined when nothing usable.
 */
export function buildLoggedWorkoutItems(
  exercises: Exercise[],
  makeIdFn: () => string,
): string[] | undefined {
  const lines: string[] = [];
  for (const ex of exercises) {
    const name = cleanName(ex?.name);
    if (!name) continue;
    const bodyweight = !isWeightedExercise(ex);
    const summary = sanitizeLine(summarizeSets(setsFor(ex, makeIdFn), bodyweight));
    lines.push(summary ? `${name} ${summary}` : name);
  }
  if (lines.length === 0) return undefined;
  return lines.length > MAX_WORKOUT_ITEMS
    ? [...lines.slice(0, MAX_WORKOUT_ITEMS), `他${lines.length - MAX_WORKOUT_ITEMS}件`]
    : lines;
}

/**
 * Build the minimal coaching context from client-side data. Pure + testable:
 * only includes fields that are actually known (no profile → no targets, no
 * meals → no intake), so the coach is never handed an invented number.
 */
export function buildChatContext(args: {
  profile: Profile | null;
  targets: NutritionTargets | null;
  intake: IntakeTotals | null;
  burnKcal?: number;
  /** Current local date+time, pre-formatted by the caller (formatNowText). */
  nowText?: string;
  /** Today's actually-logged meal times (slot + local HH:MM). */
  loggedMeals?: LoggedMealTime[];
  /** Local time today's workout was logged (HH:MM), when any exercise was logged. */
  loggedWorkoutTime?: string;
  /** WHAT was logged today per meal slot (item names + portions) — own logged data. */
  loggedMealItems?: LoggedMealContent[];
  /** WHAT exercises were logged today (name + set summary) — own logged data. */
  loggedWorkoutItems?: string[];
  /** User-chosen coach persona (presentation only); absent → default 健康マン. */
  coach?: ChatCoachPersona;
}): ChatContext {
  const {
    profile,
    targets,
    intake,
    burnKcal,
    nowText,
    loggedMeals,
    loggedWorkoutTime,
    loggedMealItems,
    loggedWorkoutItems,
    coach,
  } = args;
  const ctx: ChatContext = {};

  // Coach persona is presentation-only; only attach it when the user actually
  // chose something (so an empty object never overrides the prompt default).
  if (coach && (coach.name || coach.gender || coach.style)) ctx.coach = coach;

  // Time awareness — factual (device clock + real logged times). Only emit what
  // we actually have, so the coach is never handed an invented time.
  if (nowText && nowText.trim()) ctx.nowText = nowText.trim();
  if (loggedMeals && loggedMeals.length > 0) ctx.loggedMeals = loggedMeals;
  if (loggedWorkoutTime && loggedWorkoutTime.trim()) ctx.loggedWorkoutTime = loggedWorkoutTime.trim();

  // WHAT was actually logged today (content, not just totals/timings). Only set
  // when there's real logged content; an empty/absent day omits the block so the
  // coach never asserts the user ate/did nothing (it says 記録がまだ if asked).
  if (loggedMealItems && loggedMealItems.length > 0) ctx.loggedMealItems = loggedMealItems;
  if (loggedWorkoutItems && loggedWorkoutItems.length > 0) {
    ctx.loggedWorkoutItems = loggedWorkoutItems;
  }

  if (profile) {
    if (profile.name && profile.name.trim()) ctx.name = profile.name.trim();
    ctx.goal = goalLabel(profile.goal);
    // The user's OWN registered身体情報 → their own coach can confirm + ground in
    // it. Only set fields are carried (omitted when nothing is registered).
    const registered = buildRegisteredProfile(profile);
    if (registered) ctx.registered = registered;
  }
  if (targets) {
    ctx.targetKcal = targets.calories;
    ctx.targetProteinG = targets.proteinG;
    ctx.targetFatG = targets.fatG;
    ctx.targetCarbG = targets.carbG;
  }
  // Only surface intake if at least one meal carried nutrition.
  if (intake && intake.loggedCount > 0) {
    ctx.intakeKcal = Math.round(intake.calories);
    ctx.intakeProteinG = Math.round(intake.proteinG);
    ctx.intakeFatG = Math.round(intake.fatG);
    ctx.intakeCarbG = Math.round(intake.carbG);
  }
  if (typeof burnKcal === "number" && Number.isFinite(burnKcal) && burnKcal > 0) {
    ctx.burnKcal = Math.round(burnKcal);
  }

  return ctx;
}

export interface SendChatOptions {
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Endpoint, overridable for tests. */
  endpoint?: string;
}

function readApiToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Call the backend and return the coach's reply text.
 * Throws on a network error, non-OK status, or an empty reply (the caller keeps
 * the conversation and surfaces an honest error).
 */
export async function sendChat(
  messages: ChatWireMessage[],
  context: ChatContext | undefined,
  options: SendChatOptions = {},
): Promise<string> {
  if (!messages.length) throw new Error("メッセージが必要です");
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? "/api/chat";
  const headers: Record<string, string> = { "content-type": "application/json" };
  const apiToken = readApiToken();
  if (apiToken) headers["X-Health-App-Token"] = apiToken;

  const res = await doFetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages, context }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("アクセスキーを設定してください");
    if (res.status === 503) throw new Error("チャットは今使えません");
    throw new Error(`返信を取得できませんでした (${res.status})`);
  }
  const data = (await res.json()) as { reply?: unknown };
  const reply = typeof data.reply === "string" ? data.reply.trim() : "";
  if (!reply) throw new Error("返信を取得できませんでした");
  return reply;
}

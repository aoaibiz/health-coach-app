// POST /api/chat — the chat-coach BFF (PRD §F6/Phase 5). Thin proxy to a
// ChatProvider (CodexChatProvider in production — Codex CLI subscription, NO
// paid API / NO API key). The provider returns a normal free-text reply; this
// handler validates input, shapes the conversation + minimal context, calls the
// provider, and returns the reply. On any provider failure it returns an honest
// 502 — it never fabricates a reply.
//
// Exports:
//   - handleChat(request, provider): pure, framework-free — the shared core used
//     by the Node server AND unit tests (mock Request + a MockChatProvider, no
//     network, no real CLI). THIS is the live code path.
//
// Auth + concurrency are enforced by the Node route (server/index.mjs), exactly
// like /api/analyze-meal: X-Health-App-Token gate, 503 when the env token is
// unset, 401 on mismatch, shared concurrency cap.

import type { ChatProvider } from "../_llm/chat";
import {
  COACH_GENDERS,
  COACH_STYLES,
  type ChatContext,
  type ChatTurn,
  type CoachGender,
  type CoachHistorySummary,
  type CoachPersona,
  type CoachStyle,
  type ExerciseProgress,
  type FridgeAnalysisContext,
  type FridgeIngredient,
  type LoggedMealContent,
  type LoggedMealTime,
  type MealAnalysisContext,
  type MealAnalysisItem,
  type MuscleGroupStat,
  type NutritionWindowAvg,
  type ProgressTrend,
  type RecentDaySummary,
  type RegisteredProfile,
  type SleepWindowAvg,
  type TodayCalendarEvent,
  type TodayPlanContext,
  type WeightTrendSummary,
} from "../_llm/chat-prompt";

/** Cap the number of turns we forward (keep the prompt small + bounded cost). */
const MAX_MESSAGES = 20;
/** Cap a single message length (defensive against giant pasted payloads). */
const MAX_CONTENT_CHARS = 4_000;

// --- Untrusted-context sanitisation (defense-in-depth) ----------------------
// Every context field is CLIENT-supplied. Even though our own client populates
// it from the device clock + real logs, the endpoint treats it as UNTRUSTED:
// the values flow verbatim into the coach prompt (formatChatContext), so a
// tampered request could otherwise inject pseudo-prompt content (a fake
// 【守るべきルール】 heading via a newline in nowText) or absurd numbers (huge /
// negative kcal → bad health advice). We use STRICT ALLOW-LIST formats, not
// blocklists: anything that doesn't match the exact shape is DROPPED (omitted),
// never passed through raw.

/**
 * Collapse a string to a single safe line: strip newlines, carriage returns,
 * tabs, and any other ASCII/Unicode control characters, then trim. This runs on
 * EVERY string context field before it can reach the prompt, so no field can
 * carry an embedded heading/instruction onto its own line.
 */
function sanitizeLine(s: string): string {
  // Strip C0 controls + DEL (\u0000–\u001F, \u007F) and C1 controls
  // (\u0080–\u009F). This covers \n \r \t, vertical tab, form feed, NEL,
  // etc., so no field can carry a second line into the prompt. Then trim.
  return s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "").trim();
}

/** Strict "current date+time" shape, e.g. "2026-06-18(火) 08:10". Weekday char
 *  must be one of 日月火水木金土. Anchored — no leading/trailing extras allowed. */
const NOW_TEXT_RE = /^\d{4}-\d{2}-\d{2}\([日月火水木金土]\) ([01]?\d|2[0-3]):[0-5]\d$/;

/** Strict local time "H:MM" / "HH:MM" (hour 0-23, minute 00-59). The client
 *  zero-pads, but existing real data also uses single-digit hours ("8:05"). */
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** The known meal-slot labels (mirrors src/lib/types Meal.type + the prompt's
 *  MEAL_SLOT_LABEL). Anything outside this set is dropped — no injected slot. */
const ALLOWED_MEAL_SLOTS = new Set(["朝", "昼", "夕", "間食"]);

/** Sane clamps for the client-supplied numbers (anti-absurd-value). */
const MAX_KCAL = 20_000;
const MAX_GRAMS = 2_000;

/** Sane human-body clamps for the registered profile numbers (anti-absurd). */
const MAX_HEIGHT_CM = 300;
const MAX_WEIGHT_KG = 700;
const MAX_AGE = 150;
const MAX_BODY_FAT_PCT = 100;
/** Max length of a localised registered-profile label once single-lined. */
const MAX_PROFILE_LABEL_CHARS = 16;

/** Max coach-name length once sanitised to a single line (UI also caps input). */
const MAX_COACH_NAME_CHARS = 24;

/** Allowed muscle-group keys (mirrors src/lib/muscleGroups MuscleGroup). A key
 *  outside this set is dropped so a tampered request can't inject a label. */
const ALLOWED_MUSCLE_GROUPS = new Set([
  "chest",
  "back",
  "legs",
  "shoulders",
  "arms",
  "core",
  "cardio",
  "other",
]);
/** The MAIN strength groups only (mirrors MAIN_MUSCLE_GROUPS). The "untrained
 *  gap" (空白) is a STRENGTH-gap concept, so cardio/other are NOT valid there —
 *  restricting this field prevents a tampered client from inventing a non-main
 *  "未トレ部位" in the prompt (Codex review). */
const ALLOWED_MAIN_GROUPS = new Set(["chest", "back", "legs", "shoulders", "arms", "core"]);
/** Allowed progression-trend keys (enum allow-list). */
const ALLOWED_TRENDS = new Set(["up", "down", "flat", "insufficient"]);
/** Bounds for the longitudinal history summary (defense-in-depth). */
const MAX_HISTORY_NUTRITION_WINDOWS = 5; // 7/14/30/90/365
const MAX_HISTORY_SLEEP_WINDOWS = 4; // 7/30/90/365
const MAX_HISTORY_MUSCLE_GROUPS = 8; // the main+aux groups
const MAX_HISTORY_PROGRESSION = 8; // top weighted lifts
const MAX_HISTORY_DAYS = 366; // any "days" field (window/span) clamp
const MAX_VOLUME_KG = 1_000_000; // a generous Σweight×reps clamp
const MAX_EXERCISE_NAME_CHARS = 40;

/** Logged-CONTENT bounds (defense-in-depth — the client also caps these). */
/** Max chars for a single item/exercise line once single-lined. */
const MAX_CONTENT_LINE_CHARS = 48;
/** Max item lines kept PER meal slot. */
const MAX_ITEM_LINES_PER_MEAL = 13; // 12 items + an optional "他N件" line
/** Max meal slots forwarded (one day's slots — bounded). */
const MAX_MEAL_CONTENT_SLOTS = 8;
/** Max workout content lines forwarded. */
const MAX_WORKOUT_CONTENT_LINES = 13; // 12 exercises + an optional "他N件" line

export interface ChatRequestBody {
  messages?: Array<{ role?: unknown; content?: unknown }>;
  context?: ChatContext;
}

export interface ChatResponse {
  reply: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

/**
 * Normalise the raw request messages into clean ChatTurns. Keeps only
 * user/assistant roles with non-empty string content, trims, clamps each to
 * MAX_CONTENT_CHARS, and keeps the LAST MAX_MESSAGES turns (the recent window).
 * Pure + exported so it's unit-testable on its own (PRD §8 "context shaping").
 */
export function shapeMessages(
  raw: ChatRequestBody["messages"] | undefined,
): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: ChatTurn[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    cleaned.push({ role, content: trimmed.slice(0, MAX_CONTENT_CHARS) });
  }
  return cleaned.slice(-MAX_MESSAGES);
}

/**
 * Clean a single string context field to a single safe line, length-clamped.
 * Returns "" (caller omits) when the value isn't a usable non-empty string.
 */
function cleanStr(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return sanitizeLine(v).slice(0, max);
}

/**
 * Clamp a client-supplied numeric field to a sane non-negative range. Rejects
 * non-numbers, NaN/Infinity, and negatives (which would drive bad health
 * advice) by returning null → the caller omits the field. Values above `max`
 * are clamped DOWN to `max` rather than dropped (a real-but-extreme total is
 * still better presented as the cap than fabricated/omitted).
 */
function cleanClampedNum(v: unknown, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v > max ? max : v;
}

/**
 * Shape the (UNTRUSTED) user-chosen coach persona that flows into the prompt
 * (Feature 2). Same discipline as the time-field hardening:
 *   - name: free text → sanitised to a SINGLE safe line (newlines + all control
 *     chars stripped so it can't carry a 【守るべきルール】 heading / pseudo-
 *     instruction onto its own line) and length-clamped. A blank/garbage name
 *     is dropped (omitted) → the prompt falls back to the default 健康マン.
 *   - gender / style: STRICT ENUM allow-list (not free text). Anything outside
 *     the fixed set is DROPPED, so neither can inject prompt content; the prompt
 *     builder also independently falls back to a default for any missing value.
 * Returns undefined when nothing usable remains (the prompt uses the default
 * persona). This is the anti-prompt-injection floor for the persona fields.
 */
export function shapeCoach(raw: unknown): CoachPersona | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { name?: unknown; gender?: unknown; style?: unknown };
  const out: CoachPersona = {};

  const name = cleanStr(r.name, MAX_COACH_NAME_CHARS);
  if (name) out.name = name;

  if (typeof r.gender === "string" && COACH_GENDERS.includes(r.gender as CoachGender)) {
    out.gender = r.gender as CoachGender;
  }
  if (typeof r.style === "string" && COACH_STYLES.includes(r.style as CoachStyle)) {
    out.style = r.style as CoachStyle;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Shape the (UNTRUSTED) registered身体情報 the client attaches to the context
 * (Fix 1). This is the LOCAL user's own profile going to their own coach, but the
 * endpoint still treats it as untrusted input — the values flow verbatim into the
 * coach prompt, so we apply the SAME discipline as the time/coach-name fields:
 *   - numbers: clamped to sane human ranges; NaN/Infinity/negative → DROPPED, so
 *     no absurd value drives bad health advice and no field is fabricated.
 *   - labels (sex/body-type/activity/goal): sanitised to a SINGLE safe line
 *     (newlines + all control chars stripped) + length-clamped, so a label can't
 *     carry a 【守るべきルール】 heading / pseudo-instruction onto its own line.
 * Only fields the user actually set are kept (unset → omitted — never invented).
 * Returns undefined when nothing usable remains, so the prompt omits the block.
 */
export function shapeRegistered(raw: unknown): RegisteredProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: RegisteredProfile = {};

  const heightCm = cleanClampedNum(r.heightCm, MAX_HEIGHT_CM);
  if (heightCm !== null) out.heightCm = heightCm;
  const weightKg = cleanClampedNum(r.weightKg, MAX_WEIGHT_KG);
  if (weightKg !== null) out.weightKg = weightKg;
  const targetWeightKg = cleanClampedNum(r.targetWeightKg, MAX_WEIGHT_KG);
  if (targetWeightKg !== null) out.targetWeightKg = targetWeightKg;
  const age = cleanClampedNum(r.age, MAX_AGE);
  if (age !== null) out.age = age;
  const bodyFatPct = cleanClampedNum(r.bodyFatPct, MAX_BODY_FAT_PCT);
  if (bodyFatPct !== null) out.bodyFatPct = bodyFatPct;

  const sexLabel = cleanStr(r.sexLabel, MAX_PROFILE_LABEL_CHARS);
  if (sexLabel) out.sexLabel = sexLabel;
  const bodyTypeLabel = cleanStr(r.bodyTypeLabel, MAX_PROFILE_LABEL_CHARS);
  if (bodyTypeLabel) out.bodyTypeLabel = bodyTypeLabel;
  const activityLabel = cleanStr(r.activityLabel, MAX_PROFILE_LABEL_CHARS);
  if (activityLabel) out.activityLabel = activityLabel;
  const goalLabel = cleanStr(r.goalLabel, MAX_PROFILE_LABEL_CHARS);
  if (goalLabel) out.goalLabel = goalLabel;

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only sane numeric fields + sanitised, strictly-shaped strings. */
export function shapeContext(raw: ChatContext | undefined): ChatContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: ChatContext = {};

  const coach = shapeCoach(raw.coach);
  if (coach) out.coach = coach;

  // The user's OWN registered身体情報 — clamped numbers + single-line labels.
  const registered = shapeRegistered(raw.registered);
  if (registered) out.registered = registered;

  // kcal fields and gram (PFC) fields get DIFFERENT sane ranges. Each is clamped
  // to [0, max]; negative / NaN / Infinity → omitted (never bad-advice numbers).
  const kcalKeys: Array<keyof ChatContext> = [
    "targetKcal",
    "intakeKcal",
    "burnKcal",
    "targetBmr",
    "targetTdee",
  ];
  const gramKeys: Array<keyof ChatContext> = [
    "targetProteinG",
    "targetFatG",
    "targetCarbG",
    "intakeProteinG",
    "intakeFatG",
    "intakeCarbG",
  ];
  for (const k of kcalKeys) {
    const n = cleanClampedNum(raw[k], MAX_KCAL);
    if (n !== null) (out[k] as number) = n;
  }
  for (const k of gramKeys) {
    const n = cleanClampedNum(raw[k], MAX_GRAMS);
    if (n !== null) (out[k] as number) = n;
  }

  // Free-text fields: stripped of newlines/control chars (single-line) + clamped,
  // so they can't carry an injected heading/instruction onto their own line.
  const goal = cleanStr(raw.goal, 40);
  if (goal) out.goal = goal;
  const name = cleanStr(raw.name, 40);
  if (name) out.name = name;

  // Time-awareness fields are UNTRUSTED client input. Accept ONLY strict shapes
  // (allow-list, not blocklist): nowText must match "YYYY-MM-DD(曜) HH:MM" exactly,
  // the workout time must be HH:MM. Anything else is DROPPED (omitted), so a
  // tampered field can never inject pseudo-prompt content into the prompt.
  const nowText = cleanStr(raw.nowText, 40);
  if (nowText && NOW_TEXT_RE.test(nowText)) out.nowText = nowText;

  const workoutTime = cleanStr(raw.loggedWorkoutTime, 10);
  if (workoutTime && TIME_RE.test(workoutTime)) out.loggedWorkoutTime = workoutTime;

  const loggedMeals = shapeLoggedMeals(raw.loggedMeals);
  if (loggedMeals.length > 0) out.loggedMeals = loggedMeals;

  // WHAT was logged today (content) — own data, still sanitised + bounded.
  const loggedMealItems = shapeLoggedMealItems(raw.loggedMealItems);
  if (loggedMealItems.length > 0) out.loggedMealItems = loggedMealItems;
  const loggedWorkoutItems = shapeLoggedWorkoutItems(raw.loggedWorkoutItems);
  if (loggedWorkoutItems.length > 0) out.loggedWorkoutItems = loggedWorkoutItems;

  // Today's MAJOR vitamins/minerals (拡張①) — own data, sanitised + bounded like
  // the other content lines (each single-lined + length-clamped, count capped).
  const intakeMicros = shapeIntakeMicros(raw.intakeMicros);
  if (intakeMicros.length > 0) out.intakeMicros = intakeMicros;

  // Today's sleep summary (一行) + the recent-days digest — own data, sanitised +
  // bounded like the other content fields (no injected heading, capped counts).
  const sleepToday = cleanStr(raw.sleepToday, MAX_CONTENT_LINE_CHARS);
  if (sleepToday) out.sleepToday = sleepToday;
  const recentDays = shapeRecentDays(raw.recentDays);
  if (recentDays.length > 0) out.recentDays = recentDays;

  // Longitudinal history summary (履歴ベースの傾向) — own data, still clamped +
  // enum-checked + bounded so a tampered request can't inject/balloon the prompt.
  const historySummary = shapeCoachHistory(raw.historySummary);
  if (historySummary) out.historySummary = historySummary;

  const mealAnalysis = shapeMealAnalysis(raw.mealAnalysis);
  if (mealAnalysis) out.mealAnalysis = mealAnalysis;

  // Fridge→献立 analysis (Phase2) — same untrusted-input discipline as the meal
  // analysis: ingredient names single-lined + length-clamped, grams clamped, count
  // bounded; a tampered field can't inject prompt content or balloon the list.
  const fridgeAnalysis = shapeFridgeAnalysis(raw.fridgeAnalysis);
  if (fridgeAnalysis) out.fridgeAnalysis = fridgeAnalysis;

  // 1日まるごと自動プラン: the day READ (existing calendar events) — same untrusted
  // discipline. Event summaries are single-lined + clamped; start/end must be a
  // valid zoned RFC3339 (or YYYY-MM-DD for all-day); count bounded. A tampered
  // field can't inject prompt content, balloon the list, or sneak a zoneless time.
  const todayPlan = shapeTodayPlan(raw.todayPlan);
  if (todayPlan) out.todayPlan = todayPlan;

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Max calendar events forwarded into the chat prompt (bounded cost; normal days
 *  have far fewer). */
const MAX_TODAY_PLAN_EVENTS = 30;
/** Max chars for an event summary once single-lined (anti-injection + bounded). */
const MAX_EVENT_SUMMARY_CHARS = 80;
/** Zoned RFC3339 (timed) OR YYYY-MM-DD (all-day). We REQUIRE a zone on timed
 *  values so a zoneless instant can never reach the coach (anti-fabrication: a
 *  time with no zone is ambiguous; we drop the event rather than guess). */
const EVENT_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const EVENT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid event time: a zoned RFC3339 (timed) when !allDay, or a plain date when
 *  allDay. Returns the verbatim string when valid, else null (the event is dropped). */
function cleanEventTime(raw: unknown, allDay: boolean): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (allDay) return EVENT_DATE_RE.test(s) ? s : null;
  // A timed event must carry an explicit zone AND actually parse.
  if (!EVENT_DATETIME_RE.test(s)) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

/**
 * Shape the (UNTRUSTED) day-plan READ the client attaches on a "plan my day" turn.
 * `connected:false` short-circuits to a clean { connected:false } (the coach asks
 * the user to connect; it never invents events). Otherwise each event must carry a
 * VALID start (zoned RFC3339, or a date for all-day) — an event with a missing/bad/
 * zoneless time is DROPPED (we never invent a time). The summary is sanitised to a
 * single safe line + length-clamped (no injected heading) and the list is bounded.
 * A connected day with no usable event is still { connected:true, events:[] } so the
 * coach plans freely. Returns undefined when there's nothing usable.
 */
export function shapeTodayPlan(raw: unknown): TodayPlanContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { connected?: unknown; events?: unknown };
  if (r.connected !== true) return { connected: false };

  const events: TodayCalendarEvent[] = [];
  if (Array.isArray(r.events)) {
    for (const it of r.events.slice(0, MAX_TODAY_PLAN_EVENTS)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const allDay = o.allDay === true;
      const start = cleanEventTime(o.start, allDay);
      if (!start) continue; // no usable start → drop (never invent a time)
      const end = cleanEventTime(o.end, allDay) ?? start; // missing/bad end → fall back to start
      // Summary may be empty (an untitled busy block still blocks time) — sanitised.
      const summary = cleanStr(o.summary, MAX_EVENT_SUMMARY_CHARS);
      events.push({ summary, start, end, allDay });
    }
  }
  return { connected: true, events };
}

/** Max fridge ingredients forwarded into the chat prompt (bounded cost). */
const MAX_FRIDGE_INGREDIENTS = 40;

/**
 * Shape the (untrusted) fridge analysis the client attaches to a chat turn
 * (Phase2). Mirrors shapeMealAnalysis: ok:false short-circuits; otherwise each
 * ingredient must carry a usable single-line name (length-clamped, no injected
 * heading) and an optional clamped grams; the list is bounded. An ok:true with no
 * usable ingredient yields `{ok:true, ingredients:[]}` so the coach asks rather
 * than the prompt omitting it. Returns undefined when there's nothing usable.
 */
export function shapeFridgeAnalysis(raw: unknown): FridgeAnalysisContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { ok?: unknown; ingredients?: unknown };
  const ok = r.ok === true;
  if (!ok) return { ok: false };

  if (!Array.isArray(r.ingredients)) return undefined;
  const ingredients: FridgeIngredient[] = [];
  for (const it of r.ingredients.slice(0, MAX_FRIDGE_INGREDIENTS)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = cleanStr(o.name, 60);
    if (!name) continue;
    const ingredient: FridgeIngredient = { name };
    // grams is an optional on-hand hint; clamp absurd/negative/NaN away (omit it).
    const grams = cleanClampedNum(o.grams, MAX_GRAMS);
    if (grams !== null && grams > 0) ingredient.grams = grams;
    ingredients.push(ingredient);
  }
  return { ok: true, ingredients };
}

/** Max recent days forwarded into the prompt (bounded cost). */
const MAX_RECENT_DAYS = 7;
/** For how many recent days item detail survives shaping (token-bounded by line caps). */
const MAX_RECENT_DETAIL_DAYS = MAX_RECENT_DAYS;
/** Max length of a recent-day sleep label once single-lined. */
const MAX_SLEEP_LABEL_CHARS = 20;
/** Max length of a full recent-day sleep range once single-lined. */
const MAX_SLEEP_DETAIL_CHARS = 48;

/**
 * Shape the (untrusted) recent-days digest. Each day must carry a usable label
 * (single safe line); its numbers are clamped to sane ranges (absurd/negative →
 * dropped) and the sleep string is sanitised + length-clamped. Day count is
 * bounded. A day with only a label and no usable field is dropped. Returns [] when
 * nothing usable, so the prompt omits the line (never an invented past day).
 */
export function shapeRecentDays(raw: unknown): RecentDaySummary[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentDaySummary[] = [];
  for (const [idx, it] of raw.slice(0, MAX_RECENT_DAYS).entries()) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const label = cleanStr(o.label, 24);
    if (!label) continue;
    const day: RecentDaySummary = { label };
    const intakeKcal = cleanClampedNum(o.intakeKcal, MAX_KCAL);
    if (intakeKcal !== null) day.intakeKcal = intakeKcal;
    const mealCount = cleanClampedNum(o.mealCount, 50);
    if (mealCount !== null) day.mealCount = Math.round(mealCount);
    const burnKcal = cleanClampedNum(o.burnKcal, MAX_KCAL);
    if (burnKcal !== null) day.burnKcal = burnKcal;
    const exerciseCount = cleanClampedNum(o.exerciseCount, 50);
    if (exerciseCount !== null) day.exerciseCount = Math.round(exerciseCount);
    const sleep = cleanStr(o.sleep, MAX_SLEEP_LABEL_CHARS);
    if (sleep) day.sleep = sleep;
    const sleepDetail = cleanStr(o.sleepDetail, MAX_SLEEP_DETAIL_CHARS);
    if (sleepDetail) day.sleepDetail = sleepDetail;
    // Recent item detail survives shaping for the full recent window, but remains
    // bounded via the SAME sanitisers as today's items/workouts (single-line,
    // slot allowlist, item cap). This lets the coach know the actual recent
    // contents while still preventing prompt ballooning/injection.
    if (idx < MAX_RECENT_DETAIL_DAYS) {
      const meals = shapeLoggedMealItems(o.meals);
      if (meals.length > 0) day.meals = meals;
      const workouts = shapeLoggedWorkoutItems(o.workouts);
      if (workouts.length > 0) day.workouts = workouts;
    }
    // Keep only days that carry at least one real metric (not just a label).
    if (
      day.intakeKcal !== undefined ||
      day.burnKcal !== undefined ||
      day.sleep !== undefined ||
      day.sleepDetail !== undefined ||
      day.mealCount !== undefined ||
      day.exerciseCount !== undefined ||
      day.meals !== undefined ||
      day.workouts !== undefined
    ) {
      out.push(day);
    }
  }
  return out;
}

/** Max logged meal-times forwarded (one day's slots — bounded; defensive). */
const MAX_LOGGED_MEALS = 12;

/**
 * Shape the (untrusted) list of today's logged meal times. Strict allow-list:
 * the slot must be a KNOWN label (朝/昼/夕/間食) and the time must match HH:MM
 * (00-23:00-59) exactly — both are sanitised to a single line first. Entries
 * that don't validate are DROPPED, and the count is bounded. Returns [] when
 * there's nothing usable so the prompt simply omits the line (never an invented
 * or injected time/slot).
 */
export function shapeLoggedMeals(raw: unknown): LoggedMealTime[] {
  if (!Array.isArray(raw)) return [];
  const out: LoggedMealTime[] = [];
  for (const it of raw.slice(0, MAX_LOGGED_MEALS)) {
    if (!it || typeof it !== "object") continue;
    const o = it as { type?: unknown; time?: unknown };
    const type = cleanStr(o.type, 10);
    const time = cleanStr(o.time, 10);
    if (!ALLOWED_MEAL_SLOTS.has(type)) continue;
    if (!TIME_RE.test(time)) continue;
    out.push({ type, time });
  }
  return out;
}

/**
 * Shape the (untrusted) list of today's logged MEAL content (WHAT was eaten),
 * grouped by slot. Same discipline as shapeLoggedMeals/shapeRegistered: the slot
 * must be a KNOWN label (朝/昼/夕/間食), each item line is sanitised to a single
 * safe line (no injected heading) + length-clamped, the per-slot item count and
 * the slot count are both bounded, and a slot with no usable items is DROPPED.
 * This is the user's OWN logged data → their own coach; we still bound + sanitise
 * it. Returns [] when nothing usable (the prompt omits the line — never invented).
 */
export function shapeLoggedMealItems(raw: unknown): LoggedMealContent[] {
  if (!Array.isArray(raw)) return [];
  const out: LoggedMealContent[] = [];
  for (const it of raw.slice(0, MAX_MEAL_CONTENT_SLOTS)) {
    if (!it || typeof it !== "object") continue;
    const o = it as { type?: unknown; items?: unknown };
    const type = cleanStr(o.type, 10);
    if (!ALLOWED_MEAL_SLOTS.has(type)) continue;
    if (!Array.isArray(o.items)) continue;
    const items: string[] = [];
    for (const line of o.items.slice(0, MAX_ITEM_LINES_PER_MEAL)) {
      const s = cleanStr(line, MAX_CONTENT_LINE_CHARS);
      if (s) items.push(s);
    }
    if (items.length === 0) continue;
    out.push({ type, items });
  }
  return out;
}

/**
 * Shape the (untrusted) list of today's logged WORKOUT content (WHAT exercises
 * were done). Each entry is sanitised to a single safe line + length-clamped, and
 * the count is bounded. Returns [] when nothing usable (the prompt omits the line).
 */
export function shapeLoggedWorkoutItems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const line of raw.slice(0, MAX_WORKOUT_CONTENT_LINES)) {
    const s = cleanStr(line, MAX_CONTENT_LINE_CHARS);
    if (s) out.push(s);
  }
  return out;
}

/** Max intake-micro lines forwarded (拡張① — the curated 主要 set is ~10; cap is
 *  bounded defense-in-depth so a tampered request can't balloon the prompt). */
const MAX_INTAKE_MICRO_LINES = 18;

/**
 * Shape the (untrusted) today's-intake micros summary (拡張①). The client sends
 * pre-formatted "label value unit" lines for the bounded 主要 set; the endpoint
 * still treats them as untrusted — each line is sanitised to a single safe line
 * (no injected heading) + length-clamped, and the count is bounded. Returns []
 * when nothing usable (the prompt omits the line — an unlogged micro is never 0).
 */
export function shapeIntakeMicros(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const line of raw.slice(0, MAX_INTAKE_MICRO_LINES)) {
    const s = cleanStr(line, MAX_CONTENT_LINE_CHARS);
    if (s) out.push(s);
  }
  return out;
}

/** Max analysed items forwarded into the chat prompt (bounded cost). */
const MAX_ANALYSIS_ITEMS = 20;

/**
 * Shape the (untrusted) grounded photo-analysis the client attaches to a chat
 * turn. We forward only the fields the prompt narrates from — name/grams/kcal/
 * PFC/source — clamped + bounded. This is presentation context for the coach; it
 * never becomes the LOGGED number (the client re-grounds the auto-log payload).
 */
export function shapeMealAnalysis(raw: unknown): MealAnalysisContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { ok?: unknown; items?: unknown; estimated?: unknown };
  const ok = r.ok === true;
  if (!ok) return { ok: false };

  if (!Array.isArray(r.items)) return undefined;
  const items: MealAnalysisItem[] = [];
  for (const it of r.items.slice(0, MAX_ANALYSIS_ITEMS)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = cleanStr(o.name, 60);
    // grams must be a sane, non-negative portion; clamp absurd values down.
    const grams = cleanClampedNum(o.grams, MAX_GRAMS);
    if (!name || grams === null) continue;
    const sk = o.sourceKind;
    const item: MealAnalysisItem = {
      name,
      grams,
      // kcal/PFC are nullable narration numbers — clamp to sane ranges; an
      // absurd/negative/NaN value becomes null (the prompt omits it) rather
      // than feeding the coach a fabricated-looking figure.
      kcal: cleanClampedNum(o.kcal, MAX_KCAL),
      proteinG: cleanClampedNum(o.proteinG, MAX_GRAMS),
      fatG: cleanClampedNum(o.fatG, MAX_GRAMS),
      carbG: cleanClampedNum(o.carbG, MAX_GRAMS),
      sourceKind:
        sk === "db" || sk === "label" || sk === "estimate" ? sk : null,
      sourceLabel: cleanStr(o.sourceLabel, 20) || null,
    };
    items.push(item);
  }
  if (items.length === 0) return { ok: true, items: [] };
  return { ok: true, items, estimated: r.estimated === true };
}

/**
 * Shape the (untrusted) longitudinal history summary the client attaches. This
 * is the user's OWN aggregated history going to their own coach, but the endpoint
 * still treats it as untrusted — every number is clamped to a sane range
 * (NaN/Infinity/negative → dropped), every key is enum/allow-list checked
 * (muscle groups, trends), every name is sanitised to a single safe line +
 * length-clamped, and every list is bounded. A block with nothing usable is
 * omitted, so the prompt never reads an injected/absurd trend. Returns undefined
 * when nothing usable remains.
 */
export function shapeCoachHistory(raw: unknown): CoachHistorySummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: CoachHistorySummary = {};

  // --- Nutrition windows ---
  if (Array.isArray(r.nutrition)) {
    const nutrition: NutritionWindowAvg[] = [];
    for (const it of r.nutrition.slice(0, MAX_HISTORY_NUTRITION_WINDOWS)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const days = cleanClampedNum(o.days, MAX_HISTORY_DAYS);
      const loggedDays = cleanClampedNum(o.loggedDays, MAX_HISTORY_DAYS);
      if (days === null || loggedDays === null) continue;
      const w: NutritionWindowAvg = { days: Math.round(days), loggedDays: Math.round(loggedDays) };
      const avgKcal = cleanClampedNum(o.avgKcal, MAX_KCAL);
      if (avgKcal !== null) w.avgKcal = Math.round(avgKcal);
      const avgProteinG = cleanClampedNum(o.avgProteinG, MAX_GRAMS);
      if (avgProteinG !== null) w.avgProteinG = Math.round(avgProteinG);
      const avgFatG = cleanClampedNum(o.avgFatG, MAX_GRAMS);
      if (avgFatG !== null) w.avgFatG = Math.round(avgFatG);
      const avgCarbG = cleanClampedNum(o.avgCarbG, MAX_GRAMS);
      if (avgCarbG !== null) w.avgCarbG = Math.round(avgCarbG);
      const proteinDeficitG = cleanClampedNum(o.proteinDeficitG, MAX_GRAMS);
      if (proteinDeficitG !== null) w.proteinDeficitG = Math.round(proteinDeficitG);
      // kcalVsTarget is SIGNED (surplus +, deficit −) → clamp magnitude, keep sign.
      const kvt = o.kcalVsTarget;
      if (typeof kvt === "number" && Number.isFinite(kvt)) {
        w.kcalVsTarget = Math.round(Math.max(-MAX_KCAL, Math.min(MAX_KCAL, kvt)));
      }
      nutrition.push(w);
    }
    if (nutrition.length > 0) out.nutrition = nutrition;
  }

  // --- Sleep windows ---
  if (Array.isArray(r.sleep)) {
    const sleep: SleepWindowAvg[] = [];
    for (const it of r.sleep.slice(0, MAX_HISTORY_SLEEP_WINDOWS)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const days = cleanClampedNum(o.days, MAX_HISTORY_DAYS);
      const loggedDays = cleanClampedNum(o.loggedDays, MAX_HISTORY_DAYS);
      if (days === null || loggedDays === null) continue;
      const w: SleepWindowAvg = { days: Math.round(days), loggedDays: Math.round(loggedDays) };
      const avgDurationMin = cleanClampedNum(o.avgDurationMin, 24 * 60);
      if (avgDurationMin !== null) w.avgDurationMin = Math.round(avgDurationMin);
      const shortSleepDays = cleanClampedNum(o.shortSleepDays, MAX_HISTORY_DAYS);
      if (shortSleepDays !== null) w.shortSleepDays = Math.round(shortSleepDays);
      const longSleepDays = cleanClampedNum(o.longSleepDays, MAX_HISTORY_DAYS);
      if (longSleepDays !== null) w.longSleepDays = Math.round(longSleepDays);
      sleep.push(w);
    }
    if (sleep.length > 0) out.sleep = sleep;
  }

  // --- Muscle-group frequency ---
  if (Array.isArray(r.muscleGroups)) {
    const groups: MuscleGroupStat[] = [];
    for (const it of r.muscleGroups.slice(0, MAX_HISTORY_MUSCLE_GROUPS)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const group = typeof o.group === "string" ? o.group : "";
      if (!ALLOWED_MUSCLE_GROUPS.has(group)) continue;
      const daysTrained = cleanClampedNum(o.daysTrained, MAX_HISTORY_DAYS);
      const sessions = cleanClampedNum(o.sessions, 1000);
      const stat: MuscleGroupStat = {
        group,
        daysTrained: daysTrained === null ? 0 : Math.round(daysTrained),
        sessions: sessions === null ? 0 : Math.round(sessions),
        daysSinceLast: null,
      };
      const since = cleanClampedNum(o.daysSinceLast, MAX_HISTORY_DAYS);
      stat.daysSinceLast = since === null ? null : Math.round(since);
      groups.push(stat);
    }
    if (groups.length > 0) out.muscleGroups = groups;
  }

  // --- Untrained groups (空白) — enum allow-list, deduped, bounded ---
  if (Array.isArray(r.untrainedGroups)) {
    const seen = new Set<string>();
    const untrained: string[] = [];
    for (const g of r.untrainedGroups.slice(0, MAX_HISTORY_MUSCLE_GROUPS)) {
      // MAIN groups only — a "未トレ部位" gap is a strength concept, so cardio/
      // other are not valid here (and can't be injected as a fake gap).
      if (typeof g !== "string" || !ALLOWED_MAIN_GROUPS.has(g) || seen.has(g)) continue;
      seen.add(g);
      untrained.push(g);
    }
    if (untrained.length > 0) out.untrainedGroups = untrained;
  }

  const workoutDays = cleanClampedNum(r.workoutDaysInWindow, MAX_HISTORY_DAYS);
  if (workoutDays !== null) out.workoutDaysInWindow = Math.round(workoutDays);

  const muscleWindowDays = cleanClampedNum(r.muscleWindowDays, MAX_HISTORY_DAYS);
  if (muscleWindowDays !== null) out.muscleWindowDays = Math.round(muscleWindowDays);

  // --- Annual muscle-group frequency ---
  if (Array.isArray(r.longTermMuscleGroups)) {
    const groups: MuscleGroupStat[] = [];
    for (const it of r.longTermMuscleGroups.slice(0, MAX_HISTORY_MUSCLE_GROUPS)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const group = typeof o.group === "string" ? o.group : "";
      if (!ALLOWED_MUSCLE_GROUPS.has(group)) continue;
      const daysTrained = cleanClampedNum(o.daysTrained, MAX_HISTORY_DAYS);
      const sessions = cleanClampedNum(o.sessions, 1000);
      const stat: MuscleGroupStat = {
        group,
        daysTrained: daysTrained === null ? 0 : Math.round(daysTrained),
        sessions: sessions === null ? 0 : Math.round(sessions),
        daysSinceLast: null,
      };
      const since = cleanClampedNum(o.daysSinceLast, MAX_HISTORY_DAYS);
      stat.daysSinceLast = since === null ? null : Math.round(since);
      groups.push(stat);
    }
    if (groups.length > 0) out.longTermMuscleGroups = groups;
  }

  const longTermWorkoutDays = cleanClampedNum(r.longTermWorkoutDays, MAX_HISTORY_DAYS);
  if (longTermWorkoutDays !== null) out.longTermWorkoutDays = Math.round(longTermWorkoutDays);
  const longTermWindowDays = cleanClampedNum(r.longTermWindowDays, MAX_HISTORY_DAYS);
  if (longTermWindowDays !== null) out.longTermWindowDays = Math.round(longTermWindowDays);

  // --- Progression ---
  if (Array.isArray(r.progression)) {
    const prog: ExerciseProgress[] = [];
    for (const it of r.progression.slice(0, MAX_HISTORY_PROGRESSION)) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const name = cleanStr(o.name, MAX_EXERCISE_NAME_CHARS);
      if (!name) continue;
      const group =
        typeof o.group === "string" && ALLOWED_MUSCLE_GROUPS.has(o.group) ? o.group : "other";
      const trend: ProgressTrend =
        typeof o.trend === "string" && ALLOWED_TRENDS.has(o.trend)
          ? (o.trend as ProgressTrend)
          : "insufficient";
      const sessions = cleanClampedNum(o.sessions, 1000);
      const bestVolumeKg = cleanClampedNum(o.bestVolumeKg, MAX_VOLUME_KG);
      const topWeightKg = cleanClampedNum(o.topWeightKg, MAX_WEIGHT_KG);
      const recentVolumeKg = cleanClampedNum(o.recentVolumeKg, MAX_VOLUME_KG);
      const firstVolumeKg = cleanClampedNum(o.firstVolumeKg, MAX_VOLUME_KG);
      // The numbers are what the prompt RENDERS as logged volumes/weights, so an
      // invalid/missing one must DROP the item — never coerce to a fabricated 0kg
      // that the coach would state as a real logged figure (Codex review).
      if (
        bestVolumeKg === null ||
        topWeightKg === null ||
        recentVolumeKg === null ||
        firstVolumeKg === null
      ) {
        continue;
      }
      prog.push({
        name,
        group,
        sessions: sessions === null ? 0 : Math.round(sessions),
        bestVolumeKg,
        topWeightKg,
        recentVolumeKg,
        firstVolumeKg,
        trend,
      });
    }
    if (prog.length > 0) out.progression = prog;
  }

  // --- Weight trend ---
  if (r.weightTrend && typeof r.weightTrend === "object") {
    const o = r.weightTrend as Record<string, unknown>;
    const startKg = cleanClampedNum(o.startKg, MAX_WEIGHT_KG);
    const latestKg = cleanClampedNum(o.latestKg, MAX_WEIGHT_KG);
    if (startKg !== null && latestKg !== null) {
      const spanDays = cleanClampedNum(o.spanDays, MAX_HISTORY_DAYS);
      // deltaKg is SIGNED → clamp magnitude, keep sign (recompute if garbage).
      const rawDelta = o.deltaKg;
      const deltaKg =
        typeof rawDelta === "number" && Number.isFinite(rawDelta)
          ? Math.max(-MAX_WEIGHT_KG, Math.min(MAX_WEIGHT_KG, rawDelta))
          : latestKg - startKg;
      const wt: WeightTrendSummary = {
        startKg,
        latestKg,
        deltaKg: Math.round(deltaKg * 10) / 10,
        spanDays: spanDays === null ? 0 : Math.round(spanDays),
      };
      out.weightTrend = wt;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Core handler — pure and testable. Takes any ChatProvider so tests pass a
 * MockChatProvider (no network). Validates input, calls the provider, returns
 * the reply. Never fabricates a reply on failure (honest 502).
 */
export async function handleChat(
  request: Request,
  provider: ChatProvider,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const messages = shapeMessages(body.messages);
  if (messages.length === 0) {
    return errorResponse("メッセージが必要です", 400);
  }
  // The last turn must be from the user — we're replying to them.
  if (messages[messages.length - 1].role !== "user") {
    return errorResponse("最後のメッセージはユーザーのものである必要があります", 400);
  }

  const context = shapeContext(body.context);

  let reply: string;
  try {
    reply = await provider.reply({ messages, context });
  } catch {
    // Honest failure — never fabricate a coach reply.
    return errorResponse("返信を生成できませんでした。あとで再試行できます。", 502);
  }

  if (typeof reply !== "string" || !reply.trim()) {
    return errorResponse("返信を生成できませんでした。あとで再試行できます。", 502);
  }

  const responseBody: ChatResponse = { reply: reply.trim() };
  return json(responseBody);
}

export type { ChatContext, ChatTurn };

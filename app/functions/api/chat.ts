// POST /api/chat — the chat-coach BFF (PRD §F6/Phase 5). Thin proxy to a
// ChatProvider (CodexChatProvider in production — Codex CLI subscription, NO
// paid API / NO API key). The provider returns a normal free-text reply; this
// handler validates input, shapes the conversation + minimal context, calls the
// provider, and returns the reply. On any provider failure it returns an honest
// 502 — it never fabricates a reply.
//
// Exports:
//   - handleChat(request, provider): pure, framework-free — the shared core used
//     by BOTH the Node server and the member CF deploy (and unit tests with a
//     MockChatProvider, no network, no real CLI).
//   - onRequestPost: ACTIVE Cloudflare Pages entry for a member self-host deploy
//     (token-gated, own-key Gemini chat).
//
// Two active runtimes, same pure core:
//   1. OUR / FAMILY — the Node route (server/index.mjs) builds a CodexChatProvider.
//   2. MEMBER SELF-HOST — onRequestPost builds the member's own-key Gemini chat
//      provider via the worker-safe ../_llm/select-own.
// Auth + concurrency are enforced at each entry: X-Health-App-Token gate, 503 when
// the env token is unset, 401 on mismatch (the Node route adds a shared concurrency
// cap), exactly like /api/analyze-meal.

import type { ChatProvider } from "../_llm/chat";
// A member's Cloudflare Pages (Workers) deploy is ALWAYS own-key, so the
// onRequestPost path uses the WORKER-SAFE selector (./select-own) that imports
// ONLY the fetch-native Gemini chat provider — never ../_llm/select, which
// references the Node-only Codex providers (node:child_process / node:fs) and
// would break the Workers bundle. The Node server keeps using ../_llm/select.
import { makeOwnKeyChatProvider, type ProviderEnv } from "../_llm/select-own";
import {
  COACH_GENDERS,
  COACH_STYLES,
  type ChatContext,
  type ChatTurn,
  type CoachGender,
  type CoachPersona,
  type CoachStyle,
  type LoggedMealContent,
  type LoggedMealTime,
  type MealAnalysisContext,
  type MealAnalysisItem,
  type RecentDaySummary,
  type RegisteredProfile,
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

  const mealAnalysis = shapeMealAnalysis(raw.mealAnalysis);
  if (mealAnalysis) out.mealAnalysis = mealAnalysis;

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

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Max recent days forwarded into the prompt (bounded cost). */
const MAX_RECENT_DAYS = 7;
/** Max length of a recent-day sleep label once single-lined. */
const MAX_SLEEP_LABEL_CHARS = 20;

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
  for (const it of raw.slice(0, MAX_RECENT_DAYS)) {
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
    // Keep only days that carry at least one real metric (not just a label).
    if (
      day.intakeKcal !== undefined ||
      day.burnKcal !== undefined ||
      day.sleep !== undefined ||
      day.mealCount !== undefined ||
      day.exerciseCount !== undefined
    ) {
      out.push(day);
    }
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

// ---- Cloudflare Pages Functions entry (member self-host deploy) -----------
// The chat route a MEMBER's own Cloudflare Pages deploy runs. Selects the AI
// provider from the deploy's env via select.ts (AI_MODE=own + AI_PROVIDER=gemini
// → the member's own GEMINI_API_KEY; default → Codex), then calls the SAME pure
// handleChat() the Node server uses. Access-gated IDENTICALLY to analyze-meal:
// X-Health-App-Token must match the deploy's APP_ACCESS_TOKEN env (fail-closed
// 503 when unset, 401 on mismatch). Honest errors, never fabricates a reply.

interface PagesContext {
  request: Request;
  env: ChatEnv;
}

/** The env a member's Pages deploy provides (provider selection + access gate). */
type ChatEnv = ProviderEnv & { APP_ACCESS_TOKEN?: string };

/**
 * Constant-time-ish token comparison without Node crypto (CF Workers runtime).
 * Length check first (lengths are not secret), then a non-short-circuiting XOR
 * accumulate so the decision time doesn't leak the prefix.
 */
function tokensMatch(provided: string | null, expected: string): boolean {
  if (typeof provided !== "string") return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** ACTIVE CF Pages Functions handler — member self-host deploy chat entry. */
export async function onRequestPost(context: PagesContext): Promise<Response> {
  const expected = context.env.APP_ACCESS_TOKEN ?? "";
  if (!expected) {
    return json(
      { error: "chat_unavailable", message: "チャットは準備中です。" },
      503,
    );
  }
  if (!tokensMatch(context.request.headers.get("x-health-app-token"), expected)) {
    return errorResponse("unauthorized", 401);
  }

  let provider: ChatProvider;
  try {
    provider = makeOwnKeyChatProvider(context.env);
  } catch {
    return json(
      { error: "chat_unavailable", message: "チャットは準備中です。" },
      503,
    );
  }
  return handleChat(context.request, provider);
}

export type { ChatContext, ChatTurn };

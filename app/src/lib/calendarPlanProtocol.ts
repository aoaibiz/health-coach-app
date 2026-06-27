// Structured CALENDAR_PLAN protocol (chat→Googleカレンダー flow).
//
// THE SIDE CHANNEL (mirrors mealLogProtocol.ts). When the coach (健康マン) and the
// user have agreed on a plan to put on the calendar, the coach's reply carries —
// alongside the natural prose — a single fenced sentinel block describing the
// events to create. The client detects that block, parses + validates it, STRIPS
// it from the displayed text (the user only ever sees natural Japanese, never raw
// JSON), and forwards the validated plan to the calendar API (which creates the
// events on the user's OWN Google Calendar, server-side, with their stored token).
//
// ┌─ FABRICATION SAFETY ──────────────────────────────────────────────────────┐
// │ This module ONLY parses + validates + strips. It never invents a time: an   │
// │ item with a missing/bad/zoneless datetime or end<=start is DROPPED, and a    │
// │ block with no valid item yields a null payload (nothing is scheduled). The   │
// │ server re-validates identically before touching Google Calendar.            │
// └────────────────────────────────────────────────────────────────────────────┘
//
// PURE + framework-free (no DOM, no network) so the parse/strip is unit-tested in
// isolation and reused verbatim by the chat client.

/** The sentinel that fences the structured block (kept in sync with
 *  functions/_llm/chat-prompt.ts CALENDAR_PLAN_OPEN/CLOSE). */
export const CALENDAR_PLAN_OPEN = "«CALENDAR_PLAN»";
export const CALENDAR_PLAN_CLOSE = "«/CALENDAR_PLAN»";

/** The item types the coach may schedule (mirrors the server allow-list). */
export const CALENDAR_PLAN_TYPES = ["食事", "トレーニング", "タスク"] as const;
export type CalendarPlanType = (typeof CALENDAR_PLAN_TYPES)[number];

/** One validated event the coach wants on the calendar. */
export interface CalendarPlanItem {
  type: CalendarPlanType;
  title: string;
  /** RFC3339 start datetime WITH an explicit offset/Z (validated). */
  start: string;
  end: string;
  notes?: string;
}

/** The full parsed plan payload. */
export interface CalendarPlanPayload {
  items: CalendarPlanItem[];
  /** Optional IANA time zone the client attaches (e.g. "Asia/Tokyo"). */
  timeZone?: string;
}

/** The result of scanning a coach reply for a CALENDAR_PLAN block. */
export interface ParsedCalendarReply {
  /** The natural-language text to show in the bubble (sentinel block removed). */
  display: string;
  /** The structured plan to schedule, or null when none/invalid. */
  payload: CalendarPlanPayload | null;
}

const TYPE_SET = new Set<string>(CALENDAR_PLAN_TYPES);
/** RFC3339 with date + time + an explicit zone (offset or Z) — same as the server. */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const MAX_ITEMS = 20;
const MAX_TITLE = 200;
const MAX_NOTES = 2000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match the FIRST sentinel block (non-greedy), capturing its inner text. */
const BLOCK_RE = new RegExp(
  `${escapeRegExp(CALENDAR_PLAN_OPEN)}([\\s\\S]*?)${escapeRegExp(CALENDAR_PLAN_CLOSE)}`,
);

function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ").trim().slice(0, MAX_TITLE);
  return s.length > 0 ? s : null;
}

function cleanNotes(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Keep \n / \t / \r; strip the rest of the C0/C1 controls + line separators.
  // eslint-disable-next-line no-control-regex
  const s = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, "")
    .trim()
    .slice(0, MAX_NOTES);
  return s.length > 0 ? s : undefined;
}

/** A valid RFC3339-with-zone datetime that actually parses, else null. */
function validDateTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!RFC3339_RE.test(s)) return null;
  return Number.isFinite(Date.parse(s)) ? s : null;
}

/** Coerce one raw item into a clean CalendarPlanItem, or null if unusable. */
function toItem(raw: unknown): CalendarPlanItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== "string" || !TYPE_SET.has(r.type)) return null;
  const title = cleanTitle(r.title);
  if (!title) return null;
  const start = validDateTime(r.start);
  const end = validDateTime(r.end);
  if (!start || !end) return null;
  if (Date.parse(end) <= Date.parse(start)) return null;
  const item: CalendarPlanItem = { type: r.type as CalendarPlanType, title, start, end };
  const notes = cleanNotes(r.notes);
  if (notes) item.notes = notes;
  return item;
}

/** Parse the inner JSON of a block into a CalendarPlanPayload, or null when it
 *  yields no usable item. Tolerant of a leading ```json fence. */
function parseBlockBody(body: string): CalendarPlanPayload | null {
  let text = body.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(text);
  if (fence) text = fence[1].trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rawItems = (parsed as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) return null;
  const items = rawItems
    .slice(0, MAX_ITEMS)
    .map(toItem)
    .filter((i): i is CalendarPlanItem => i !== null);
  if (items.length === 0) return null;

  const payload: CalendarPlanPayload = { items };
  const tz = (parsed as { timeZone?: unknown }).timeZone;
  if (typeof tz === "string" && tz.trim()) payload.timeZone = tz.trim();
  return payload;
}

/**
 * Scan a raw coach reply for the CALENDAR_PLAN block. Returns the display text
 * with the block removed (ALWAYS stripped — even when malformed, so raw JSON can
 * never reach the user) plus the parsed payload (null when none/invalid).
 */
export function parseCalendarReply(raw: string): ParsedCalendarReply {
  const match = BLOCK_RE.exec(raw);
  if (!match) return { display: raw.trim(), payload: null };
  const payload = parseBlockBody(match[1]);
  const display = raw.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { display, payload };
}

/** True when a reply contains a (possibly malformed) CALENDAR_PLAN block. */
export function hasCalendarPlanBlock(raw: string): boolean {
  return BLOCK_RE.test(raw);
}

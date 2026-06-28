// localStorage persistence for the chat conversation (PRD §F6: history kept
// locally, clearable). Mirrors storage.ts's read/write pattern. Pure-ish: the
// read/write are SSR-safe (no window → no-op), and the shaping helpers below are
// fully pure so they're unit-testable with no DOM.

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Full ISO timestamp. */
  createdAt: string;
  /**
   * IndexedDB photo key, when this (user) turn attached a meal photo. Display
   * only; the photo also backs the logged Meal so it survives in /meal. Additive
   * + optional, so older stored messages remain valid. For a multi-photo turn
   * this is the FIRST photo (kept for back-compat + as the logged meal's picture);
   * `photoIds` carries the full set.
   */
  photoId?: string;
  /**
   * All IndexedDB photo keys for a multi-photo turn (e.g. main dish + side + drink
   * shot taken separately, logged as ONE meal). Display only. Additive + optional;
   * older messages with just `photoId` remain valid.
   */
  photoIds?: string[];
  /**
   * Set on the assistant turn that auto-logged a meal. Drives the "食事に記録しました"
   * chip under the bubble. The id is the logged Meal's id, also used to resolve a
   * later "correct" block's target from PERSISTED history (the dedupe redesign).
   */
  loggedMeal?: { mealId: string; itemCount: number };
  /**
   * Set on the assistant turn that auto-logged a workout (chat→筋トレ). Drives the
   * "筋トレを記録しました" chip. `exerciseIds` are the logged exercises' ids (on `date`),
   * used to resolve a later "correct" workout block from PERSISTED history.
   */
  loggedWorkout?: { exerciseIds: string[]; date: string; exerciseCount: number };
  /**
   * Set on the assistant turn that bulk-inserted a PLANNED workout menu (chat→運動
   * メニュー提案, AIプランナー 第2陣C). Drives the "運動メニューをプランしました" chip.
   * `exerciseIds` are the planned exercises' ids (on `date`), used to resolve a
   * later "correct" WORKOUT_PLAN block from PERSISTED history. Distinct from
   * loggedWorkout (done) so a plan correction never touches a done record.
   */
  plannedWorkout?: { exerciseIds: string[]; date: string; exerciseCount: number };
  /**
   * Set on the assistant turn that bulk-inserted a PLANNED 献立 (chat→食事メニュー提案,
   * AIプランナー 第3陣D — the twin of plannedWorkout). Drives the "献立をプランしました"
   * chip. `mealIds` are the planned meals' ids (on `date`), used to resolve a later
   * "correct" MEAL_PLAN block from PERSISTED history. Distinct from loggedMeal
   * (eaten) so a plan correction never touches an eaten record.
   */
  plannedMeal?: { mealIds: string[]; date: string; mealCount: number };
}

export const CHAT_STORAGE_KEY = "health-app:chat:v1";

/** Cap stored history so localStorage never grows unbounded. */
const MAX_STORED = 200;

function isChatMessage(v: unknown): v is ChatMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string" &&
    typeof m.createdAt === "string"
  );
}

/** Validate/filter a raw parsed value into a clean ChatMessage[]. Pure. */
export function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isChatMessage).slice(-MAX_STORED);
}

export function loadChat(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    return sanitizeHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveChat(messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify(messages.slice(-MAX_STORED)),
    );
  } catch {
    /* quota/serialization errors are non-fatal for chat */
  }
}

export function clearChat(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Cheap equality for two chat histories — same length AND same visible content
 * plus behavior metadata pairwise. The metadata drives later corrections/deletes
 * ("今の食事消して"), so a restored history with the same bubbles but newer
 * loggedMeal/loggedWorkout ids must still replace the in-memory copy.
 */
export function sameChatHistory(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].content !== b[i].content) return false;
    if (!sameMessageMetadata(a[i], b[i])) return false;
  }
  return true;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function sameMessageMetadata(a: ChatMessage, b: ChatMessage): boolean {
  return (
    sameJson(a.loggedMeal, b.loggedMeal) &&
    sameJson(a.loggedWorkout, b.loggedWorkout) &&
    sameJson(a.plannedWorkout, b.plannedWorkout) &&
    sameJson(a.plannedMeal, b.plannedMeal)
  );
}

/**
 * Map stored ChatMessages to the wire format the backend expects (role +
 * content only), keeping the most recent `limit` turns. Pure + testable.
 */
export function toWireMessages(
  messages: ChatMessage[],
  limit = MAX_STORED,
): Array<{ role: ChatRole; content: string }> {
  return messages
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
}

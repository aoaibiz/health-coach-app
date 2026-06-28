"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import {
  clearChat,
  loadChat,
  sameChatHistory,
  saveChat,
  toWireMessages,
  type ChatMessage,
} from "@/lib/chatStore";
import {
  buildChatContext,
  buildLoggedMealItems,
  buildLoggedWorkoutItems,
  sendChat,
  type ChatFridgeAnalysis,
  type ChatMealAnalysis,
  type ChatTodayPlan,
} from "@/lib/chat";
import {
  analyzeFridge,
  isFridgeMenuIntent,
  NON_FRIDGE_ANALYSIS,
} from "@/lib/fridgeMenu";
import { isDayPlanIntent, localDayWindow } from "@/lib/dayPlan";
import { calendarToday } from "@/lib/authApi";
import {
  coachToPersona,
  loadCoachSettings,
  type CoachSettings,
} from "@/lib/coachSettings";
import { analyzeMeal, blobToBase64, hasApiKey } from "@/lib/analyzeMeal";
import {
  loadMeals,
  loadProfile,
  loadWorkouts,
  saveMeals,
  saveWorkouts,
} from "@/lib/storage";
import { loadSleepLogs, saveSleepLogs } from "@/lib/sleepLog";
import { buildRecentDays, todaySleepSummary } from "@/lib/chatHistoryContext";
import { buildCoachHistory } from "@/lib/coachContext";
import { loadWeightLog } from "@/lib/weightLog";
import { calcTargets } from "@/lib/nutrition";
import { sumIntake } from "@/lib/intake";
import { workoutBurn } from "@/lib/burn";
import { toDateKey, makeId, formatTime, formatNowText } from "@/lib/date";
import type { LoggedMealTime } from "@/lib/chat";
import { compressImage } from "@/lib/image";
import { deletePhoto, putPhoto } from "@/lib/photoStore";
import { DATA_CHANGED_EVENT, recordDeletions } from "@/lib/syncData";
import { parseCoachReply } from "@/lib/mealLogProtocol";
import { parseWorkoutReply } from "@/lib/workoutLogProtocol";
import { parseCalendarReply, type CalendarPlanPayload } from "@/lib/calendarPlanProtocol";
import { runCalendarPlan } from "@/lib/chatCalendarPlan";
import {
  analysisToChatContext,
  applyMealLog,
  lastLoggedMealId,
  NON_FOOD_ANALYSIS,
} from "@/lib/chatMealLog";
import { estimateLoggedMeal } from "@/lib/chatMealEstimate";
import {
  ambiguousDateNote,
  backdatedNote,
  resolveRelativeDateKeyForKind,
} from "@/lib/relativeDate";
import { applyWorkoutLog, lastLoggedWorkoutIds } from "@/lib/chatWorkoutLog";
import { parseWorkoutPlanReply } from "@/lib/workoutPlanProtocol";
import {
  applyWorkoutPlan,
  lastPlannedWorkoutIds,
  planToCalendarPayload,
} from "@/lib/chatWorkoutPlan";
import { parseMealPlanReply } from "@/lib/mealPlanProtocol";
import {
  applyMealPlan,
  lastPlannedMealIds,
  mealPlanToCalendarPayload,
} from "@/lib/chatMealPlan";
import { parseSleepReply } from "@/lib/sleepLogProtocol";
import { applySleepLog } from "@/lib/chatSleepLog";
import { reconcileLogClaim } from "@/lib/logClaim";
import {
  deleteConfirmation,
  resolveDeleteRequestFromCoachReply,
  type ChatDeleteRequest,
} from "@/lib/chatDeleteIntent";
import type { Profile } from "@/lib/types";

/**
 * Build today's coaching context from local storage (deterministic, no LLM):
 * profile → targets, today's meals → intake, today's workout → burn. Recomputed
 * on each send so the coach always sees the latest logged data.
 */
function readTodayContext() {
  const profile = loadProfile();
  const today = toDateKey();
  const allMeals = loadMeals();
  const allWorkouts = loadWorkouts();
  const allSleep = loadSleepLogs();
  const dayMeals = allMeals.filter((m) => m.date === today);
  const workout = allWorkouts[today];
  const exercises = workout?.exercises ?? [];

  const targets = profile ? calcTargets(profile) : null;
  const intake = sumIntake(dayMeals);
  const burnKcal = profile ? workoutBurn(exercises, profile.weightKg).totalKcal : 0;

  // Time awareness: the device clock (real local time) + the REAL logged times.
  // Meals carry a per-meal timestamp → slot + HH:MM, oldest-first so the coach can
  // read spacing. Workouts are one doc/day, so the doc's updatedAt is the best-
  // available logged time (and only when something was actually logged today).
  const nowText = formatNowText();
  // Only include a logged time when its timestamp actually parses — a broken/old
  // localStorage entry would otherwise yield "NaN:NaN" into the prompt. formatTime
  // returns null for an unparseable date, so we drop those entries entirely.
  const loggedMeals: LoggedMealTime[] = [];
  for (const m of [...dayMeals]
    // Exclude not-yet-eaten PLANS (status "planned", AIプランナー 第3陣D): a 献立 the
    // user confirmed but hasn't eaten yet has a timestamp, but the coach shouldn't
    // read it as an EATEN-meal time. ABSENT status → eaten (unchanged for logged).
    .filter((m) => m.status !== "planned")
    .filter((m) => typeof m.timestamp === "string" && m.timestamp)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const time = formatTime(m.timestamp);
    if (time !== null) loggedMeals.push({ type: m.type, time });
  }
  // Only treat today as having a logged workout TIME when at least one exercise is
  // actually DONE — a day that only holds a not-yet-done PLAN (status "planned",
  // AIプランナー 第2陣C) hasn't been trained yet, so the coach shouldn't read a
  // "筋トレ HH:MM" timing for it. ABSENT status means done (unchanged for chat-logged).
  const hasDoneExercise = exercises.some((e) => e.status !== "planned");
  const loggedWorkoutTime =
    hasDoneExercise && workout?.updatedAt
      ? (formatTime(workout.updatedAt) ?? undefined)
      : undefined;

  // WHAT was logged today (content, not just times): each meal's item names +
  // portions, and each exercise's name + compact set summary. Read-only from the
  // SAME day the intake/timings use; the helpers sanitise + cap so the coach
  // genuinely knows what was eaten/done without the context ballooning.
  const loggedMealItems = buildLoggedMealItems(dayMeals);
  const loggedWorkoutItems = buildLoggedWorkoutItems(exercises, makeId);

  // Feature ① + ②: today's sleep + a compact recent-days digest (摂取/運動/睡眠)
  // so the coach sees sleep AND trends (not just today's 24h). Built from the
  // same local stores; token-bounded; nothing invented (empty days are skipped).
  const sleepToday = todaySleepSummary(allSleep, today);
  const recentDays = buildRecentDays({
    todayKey: today,
    meals: allMeals,
    workouts: allWorkouts,
    sleep: allSleep,
    weightKg: profile?.weightKg ?? null,
  });

  // Longitudinal trends (履歴ベースの傾向) — the aggregates that turn the coach into
  // a proactive trainer: nutrition/sleep averages up to 365d, recent + annual
  // muscle frequency, per-lift progression, weight trend. Built from the SAME
  // local stores; nothing invented (a quiet history yields a sparse summary the
  // coach won't over-read). buildChatContext attaches it only when it carries
  // real signal.
  const allWeights = loadWeightLog();
  const historySummary = buildCoachHistory({
    todayKey: today,
    meals: allMeals,
    workouts: allWorkouts,
    sleep: allSleep,
    weights: allWeights,
    profile,
    targets,
  });

  // The user-chosen coach persona (presentation only) rides along on the context
  // so the prompt builds the chosen voice/name; the expertise + guardrails stay
  // constant. Absent settings → undefined → the default 健康マン persona.
  const coach = coachToPersona(loadCoachSettings());

  return {
    profile,
    context: buildChatContext({
      profile,
      targets,
      intake,
      burnKcal,
      nowText,
      loggedMeals,
      loggedWorkoutTime,
      loggedMealItems,
      loggedWorkoutItems,
      sleepToday,
      recentDays,
      historySummary,
      coach,
    }),
  };
}

/** Max event summaries forwarded to the coach (bounds the context; a normal day
 *  has few). Each is sanitised to a single safe line + length-clamped. */
const MAX_DAY_PLAN_EVENTS = 30;
const MAX_EVENT_SUMMARY_CHARS = 80;

/** Strip a calendar event summary to a single safe line + clamp (untrusted text).
 *  Mirrors the sanitizeLine discipline used elsewhere (remove control chars + line
 *  separators so an event title can't carry an injected heading onto its own line). */
function cleanEventSummary(s: string): string {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "").trim().slice(0, MAX_EVENT_SUMMARY_CHARS);
}

/**
 * READ the user's existing calendar events for today (1日まるごと自動プラン) so the
 * coach can plan around them. Returns a ChatTodayPlan to attach to the context:
 *   - not connected → { connected:false } (the coach asks to connect; never invents).
 *   - connected     → { connected:true, events:[…] } with REAL events (summary
 *     sanitised + capped), so the coach plans around them.
 * FAIL-SOFT: a network/read error returns null (the day-plan context is simply
 * omitted — the coach still proposes a plan, just without the existing-events read
 * — and we NEVER fabricate events). The day WINDOW is the device's local day; the
 * userId is derived server-side from the session (never sent), so this can only
 * read the caller's own calendar. `fetchImpl` is injectable for tests.
 */
async function readTodayPlan(opts?: { fetchImpl?: typeof fetch }): Promise<ChatTodayPlan | null> {
  try {
    const window = localDayWindow(new Date());
    const result = await calendarToday(
      { timeMin: window.timeMin, timeMax: window.timeMax },
      opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined,
    );
    if (result.notConnected) return { connected: false };
    const events = result.events.slice(0, MAX_DAY_PLAN_EVENTS).map((e) => ({
      summary: cleanEventSummary(e.summary),
      start: e.start,
      end: e.end,
      allDay: e.allDay === true,
    }));
    return { connected: true, events };
  } catch {
    // Read failed (offline / transient / 502) — omit the day-plan read entirely.
    // The coach still plans, honestly without the existing-events grounding; we
    // never invent a schedule to fill the gap.
    return null;
  }
}

/** The device's IANA time zone (e.g. "Asia/Tokyo"), or undefined if unavailable.
 *  Used so a WORKOUT_PLAN's session reflection carries the right zone. */
function calendarTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz ? tz : undefined;
  } catch {
    return undefined;
  }
}

function notifyLocalDataChanged(section: "meals" | "workouts"): void {
  try {
    window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT, { detail: { section } }));
  } catch {
    /* a missed same-tab repaint falls back to navigation/focus reload */
  }
}

async function deleteMealsFromChat(ids: string[]): Promise<number> {
  const idSet = new Set(ids);
  const current = loadMeals();
  const targets = current.filter((m) => idSet.has(m.id));
  if (targets.length === 0) return 0;

  const photoIds = new Set<string>();
  for (const meal of targets) {
    for (const id of meal.photoIds ?? []) photoIds.add(id);
    if (meal.photoId) photoIds.add(meal.photoId);
    if (meal.generatedImageId) photoIds.add(meal.generatedImageId);
  }
  for (const photoId of photoIds) {
    await deletePhoto(photoId).catch(() => undefined);
  }

  recordDeletions("meals", targets.map((m) => m.id));
  saveMeals(current.filter((m) => !idSet.has(m.id)));
  notifyLocalDataChanged("meals");
  return targets.length;
}

function deleteWorkoutExercisesFromChat(request: ChatDeleteRequest): number {
  const current = loadWorkouts();
  const day = current[request.date];
  if (!day) return 0;
  const idSet = new Set(request.ids);
  const nextExercises = day.exercises.filter((e) => !idSet.has(e.id));
  const deletedCount = day.exercises.length - nextExercises.length;
  if (deletedCount <= 0) return 0;

  recordDeletions(
    "workouts",
    day.exercises.filter((e) => idSet.has(e.id)).map((e) => e.id),
  );
  saveWorkouts({
    ...current,
    [request.date]: {
      ...day,
      exercises: nextExercises,
      updatedAt: new Date().toISOString(),
    },
  });
  notifyLocalDataChanged("workouts");
  return deletedCount;
}

/**
 * Merge a coach-emitted CALENDAR_PLAN payload with the calendar reflection of a
 * confirmed WORKOUT_PLAN's session time into ONE payload, so a "menu ＋ put it on
 * my calendar" turn makes a single calendar request. Either may be null; null +
 * null → null (nothing to send). The first present payload's timeZone wins.
 */
function mergeCalendarPayloads(
  a: CalendarPlanPayload | null,
  b: CalendarPlanPayload | null,
): CalendarPlanPayload | null {
  if (a && b) {
    return {
      items: [...a.items, ...b.items],
      ...(a.timeZone ?? b.timeZone ? { timeZone: a.timeZone ?? b.timeZone } : {}),
    };
  }
  return a ?? b ?? null;
}

/** Phase of an in-flight send, so the UI can show "解析中…" vs "考え中…". */
export type SendPhase = "idle" | "analyzing" | "thinking";

export interface UseChat {
  messages: ChatMessage[];
  profile: Profile | null;
  /** The user-chosen coach persona (name/avatar/personality) for the chat UI. */
  coachSettings: CoachSettings;
  ready: boolean;
  /** True while ≥1 send is in flight (concurrent sends are supported). */
  sending: boolean;
  /** Finer-grained busy phase (photo analysis vs reply) for the loading state. */
  phase: SendPhase;
  /** Number of photos being analysed this turn (so the UI can show "3枚を解析中…"). */
  photoCount: number;
  error: string | null;
  /** Whether an access key is set — it unlocks 健康マン. Drives the setup banner. */
  hasKey: boolean;
  /**
   * Send a turn; optionally attach one OR several meal photos of the SAME meal
   * (e.g. main dish + side + drink shot taken separately). All photos are analysed
   * together as ONE meal (analyze → rally → log a single meal). Accepts a single
   * File (back-compat) or an array.
   */
  send: (text: string, photos?: File | File[] | null) => Promise<void>;
  clear: () => void;
}

const ChatContext = createContext<UseChat | null>(null);

/**
 * Holds the ONE chat conversation shared by every page. Mounted at the layout
 * level (above the App-Router page children) so navigating between pages does
 * NOT remount it — that is what lets an in-flight reply keep running and persist
 * (saveChat) even after the user leaves the chat view, and what lets the same
 * messages re-appear when they come back. State is local to the provider, mirrored
 * to localStorage so it also survives a reload.
 */
export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [coachSettings, setCoachSettings] = useState<CoachSettings>({});
  const [ready, setReady] = useState(false);
  // Number of sends currently in flight. `sending = inflight > 0`, so consecutive
  // sends can overlap without locking the input.
  const [inflight, setInflight] = useState(0);
  // Mirror of `inflight` in a ref so the mount-only refresh effect (empty deps,
  // a stale closure over state) can read the LIVE in-flight count when deciding
  // whether it's safe to re-read chat history from storage. The setInflight calls
  // below also update this ref so it never lags the state.
  const inflightRef = useRef(0);
  // How many photo-analysis sends are in flight (drives the "analyzing" phase).
  // A ref, not state: it only gates `phase` transitions and shouldn't itself
  // trigger a re-render.
  const analyzingRef = useRef(0);
  const [phase, setPhase] = useState<SendPhase>("idle");
  const [photoCount, setPhotoCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const pathname = usePathname();
  // De-dupe is no longer carried in an in-memory ref. The block now carries an
  // explicit mode (new/correct) and a "correct" resolves its target from the
  // PERSISTED chat history (loggedMeal/loggedWorkout on past assistant turns) —
  // reload-safe + clear()-safe, and a new entry can never overwrite a prior one.

  // `messagesRef` is the SYNCHRONOUS source of truth for the message list, so each
  // send builds its wire history + resolves correction targets from the LATEST
  // messages (not a stale closure) — essential when sends overlap. The only writers
  // are the initial load (below), `appendMessage`, and `clear`; there is deliberately
  // NO `messages → ref` mirror effect, which could clobber a newer ref with an older
  // render value when two sends overlap.
  const messagesRef = useRef<ChatMessage[]>([]);

  // Append a message synchronously: update the ref first (source of truth), persist,
  // then push the derived value into state. Reading from the always-current ref means
  // two overlapping sends never clobber each other's turn — and there are no side
  // effects buried inside a `setMessages` updater.
  const appendMessage = useCallback((msg: ChatMessage): ChatMessage[] => {
    const next = [...messagesRef.current, msg];
    messagesRef.current = next; // synchronous source of truth
    saveChat(next); // persist (outside any updater)
    setMessages(next); // value, derived from the always-current ref → correct under overlap
    return next;
  }, []);

  // Re-read the persisted chat into the view, but ONLY when it is safe:
  //   1. No send is in flight (inflightRef===0) — an overlapping send owns the
  //      synchronous messagesRef; re-reading mid-send could clobber its turn or
  //      drop an optimistic user bubble. We skip and let the next event retry.
  //   2. The persisted content actually DIFFERS from what's shown — avoids a
  //      needless re-render and, crucially, never DUPLICATES the conversation
  //      (same ids/length/content → no-op), and never DROPS a local edit that the
  //      server union (which can only add) already incorporated.
  // This is the surgical complement to the concurrent-send persistence design: it
  // only acts in the quiescent window where loadChat() is authoritative — which is
  // exactly the window after a login merge / cross-device pull fires DATA_CHANGED.
  const reloadChatIfSafe = useCallback(() => {
    if (inflightRef.current > 0) return; // a send owns the ref — don't touch it
    const persisted = loadChat();
    if (sameChatHistory(persisted, messagesRef.current)) return; // already shown → no-op
    messagesRef.current = persisted; // adopt the authoritative persisted history
    setMessages(persisted);
  }, []);

  useEffect(() => {
    const loaded = loadChat();
    setMessages(loaded);
    messagesRef.current = loaded;
    setProfile(loadProfile());
    setCoachSettings(loadCoachSettings());
    setHasKey(hasApiKey());
    setReady(true);

    // The key + coach persona + profile are set on the profile screen; re-check when
    // the user returns here (focus / cross-tab storage event) so the banner clears
    // and the chosen coach name/avatar + profile refresh without a reload.
    const refresh = () => {
      setHasKey(hasApiKey());
      setCoachSettings(loadCoachSettings());
      setProfile(loadProfile());
      // CHAT-HISTORY LIVE RESTORE (Ao 2026-06-24: 再ログイン直後に履歴が出ない fix).
      // login → mergeOnLogin/refreshFromServer write the merged chat into
      // localStorage and THEN fire DATA_CHANGED_EVENT (this refresh). Historically
      // we did NOT re-read messages here to protect overlapping sends — but that
      // left a just-restored history invisible until a reload (the reported bug,
      // data was safe on the server). reloadChatIfSafe re-reads ONLY when no send
      // is in flight and only when the persisted history actually differs, so it
      // can't clobber an in-flight turn or duplicate the visible conversation.
      reloadChatIfSafe();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    // In-tab login restore (mergeOnLogin) writes coach/profile/key in THIS tab
    // without a `storage` event; listen for the same-document signal so the
    // banner clears and persona/profile refresh right after login. This signal is
    // ALSO what carries the just-merged chat history into view via reloadChatIfSafe
    // above — the only safe moment to re-read messages (no send in flight, content
    // differs), which fixes "再ログイン直後に履歴が出ない" without a reload while
    // preserving the concurrent-send invariant (mid-send → the gate skips).
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
    // reloadChatIfSafe is a stable useCallback (no deps) — listed for lint honesty.
  }, [reloadChatIfSafe]);

  // The provider persists across route changes (mounted above the page children), so
  // it no longer re-reads these on remount. Editing the coach/profile on /profile then
  // navigating back to /chat would otherwise show stale values. Re-read the lightweight
  // localStorage values on every client navigation — cheap. Chat messages are re-read
  // ONLY through the safe gate (no in-flight send + content differs), so navigating
  // back to /chat after a cross-device login also shows the restored history.
  useEffect(() => {
    setHasKey(hasApiKey());
    setCoachSettings(loadCoachSettings());
    setProfile(loadProfile());
    reloadChatIfSafe();
  }, [pathname, reloadChatIfSafe]);

  const send = useCallback(
    async (text: string, photos?: File | File[] | null) => {
      const trimmed = text.trim();
      // Normalise to an ordered list of photos of the SAME meal (drop nullish).
      const photoList = (Array.isArray(photos) ? photos : photos ? [photos] : []).filter(
        (f): f is File => f instanceof File,
      );
      // Need at least text OR a photo. (Photo(s) alone is a valid "log this" turn.)
      // NOTE: we do NOT early-return on a send already being in flight — concurrent
      // sends are supported (the input stays unlocked).
      if (!trimmed && photoList.length === 0) return;
      setError(null);
      const sentAt = new Date();

      // ---- 1. Photo(s) (optional): compress + store all, analyse as ONE meal -
      // Each photo is stored in IndexedDB so the user's bubble + the logged meal
      // keep the pictures. ALL photos go into a SINGLE analyzeMeal call so the
      // model sees the whole meal together and returns one combined, grounded
      // item list (the merge happens in the model, not by stitching here).
      const photoIds: string[] = [];
      let mealAnalysis: ChatMealAnalysis | undefined;
      let fridgeAnalysis: ChatFridgeAnalysis | undefined;
      const hasPhotos = photoList.length > 0;
      // Phase2 (冷蔵庫の写真→献立): a photo turn whose TEXT asks for menu ideas is
      // routed to fridge analysis (identify ingredients → coach proposes a 献立),
      // NOT to meal logging. A plain photo (no menu-intent) stays the meal path, so
      // an everyday "log this meal" photo is never mis-routed.
      const isFridgeTurn = hasPhotos && isFridgeMenuIntent(trimmed);
      // 1日まるごと自動プラン (AIプランナー仕上げ): a turn whose TEXT explicitly asks
      // to plan the WHOLE day routes into the day-planner — we READ the user's
      // existing calendar events so the coach plans around them. A fridge-menu photo
      // turn is its own flow (献立 from ingredients), so the day-plan read is
      // skipped there to avoid double-routing; a plain "plan my day" text turn (or a
      // day-plan ask alongside a normal meal photo) still triggers it.
      const isDayPlanTurn = isDayPlanIntent(trimmed) && !isFridgeTurn;
      // Mark this send in flight up-front so the indicator shows immediately and
      // the count is balanced in the finally below. Keep the ref in lock-step so
      // the refresh effect's safe-reload gate sees an accurate live count.
      inflightRef.current += 1;
      setInflight((n) => n + 1);
      if (hasPhotos) {
        // A new photo just means a new meal analysis; the de-dupe is now driven by
        // the block's explicit mode (a photo turn logs mode:"new" by default).
        analyzingRef.current += 1;
        setPhotoCount(photoList.length);
        setPhase("analyzing");
      } else {
        setPhase((p) => (p === "analyzing" ? p : "thinking"));
      }

      try {
        if (hasPhotos) {
          try {
            const imageBase64List: string[] = [];
            for (const photo of photoList) {
              const blob = await compressImage(photo);
              const id = makeId();
              await putPhoto(id, blob);
              photoIds.push(id);
              imageBase64List.push(await blobToBase64(blob));
            }
            if (isFridgeTurn) {
              // Phase2: identify the VISIBLE INGREDIENTS so the coach can propose a
              // 献立 from them (mode:"fridge"). This logs nothing; the user records a
              // chosen menu later via the normal meal-log block. The text is passed
              // as a hint only (never trusted as a command).
              fridgeAnalysis = await analyzeFridge({
                imageBase64List,
                text: trimmed || undefined,
              });
            } else {
              // EXISTING analyzeMeal → grounded MealNutrition (DB/label/estimate),
              // now over the whole set of photos in one grounded call.
              const nutrition = await analyzeMeal({ imageBase64List });
              mealAnalysis = analysisToChatContext(nutrition);
            }
          } catch {
            // The photo(s) couldn't be analysed (non-food, unreadable, or the
            // analyzer failed). Tell the coach to handle it gracefully — never
            // fabricate a meal/menu from photos we couldn't ground.
            if (isFridgeTurn) {
              fridgeAnalysis = NON_FRIDGE_ANALYSIS;
            } else {
              mealAnalysis = NON_FOOD_ANALYSIS;
            }
          } finally {
            // Photo analysis for THIS send is done; flip to "thinking" unless
            // another send is still analysing.
            analyzingRef.current = Math.max(0, analyzingRef.current - 1);
            setPhase(analyzingRef.current > 0 ? "analyzing" : "thinking");
          }
        }

        // The first photo backs the logged meal's picture + the legacy photoId field.
        const photoId = photoIds[0];

        // The displayed user text: their words, or a friendly default for a
        // photo-only turn so the bubble isn't empty.
        const displayText =
          trimmed || (hasPhotos ? "（食事の写真を送りました）" : "");
        const userMsg: ChatMessage = {
          id: makeId(),
          role: "user",
          content: displayText,
          createdAt: sentAt.toISOString(),
          ...(photoId ? { photoId } : {}),
          ...(photoIds.length > 1 ? { photoIds } : {}),
        };
        // Synchronous append via the ref so two overlapping sends never clobber each
        // other's user turn; persist + mirror happen inside appendMessage, NOT inside
        // a setMessages updater.
        const withUser = appendMessage(userMsg);

        // NOTE(2026-06-22 Ao): 「昨日と同じ量」の“LLMを呼ばない決定的ショートカット”は撤去した。
        // コーチは最近の食事文脈(直近数日)を持つので、『昨日と同じで記録』も LLM が会話で意図を
        // 読み、meal-log protocol 経由で記録する。全メッセージを必ず LLM に通す＝考え中が出る・
        // 会話の意図を読む・未来の予定(「昨日と同じになるかと」)を即記録する誤動作も無くなる。

        // Snapshot the correction targets NOW (at send time), from the array that
        // existed when this user turn was added. This binds any correction to the
        // meal/workout that existed when the user sent it — so an overlapping
        // new-meal send can't steal the correction target by the time the reply lands.
        const correctMealId = lastLoggedMealId(withUser);
        const correctWorkoutIds = lastLoggedWorkoutIds(withUser);
        // Plan-correction target (運動メニュー提案フロー): the planned batch this chat
        // last inserted, so a "やっぱりこう変えて" replaces THAT plan (not a done log).
        const correctPlannedIds = lastPlannedWorkoutIds(withUser);
        // 献立 plan-correction target (食事メニュー提案フロー, AIプランナー 第3陣D): the
        // planned batch this chat last inserted, so a "やっぱり昼は変えて" replaces THAT
        // 献立 plan (not an eaten meal). Snapshotted at send time like the others.
        const correctPlannedMealIds = lastPlannedMealIds(withUser);

        // Feature ② (Major-2 fix): a relative-date phrase ("これ昨日の分で記入して")
        // targets a PAST day for a NEW log. Resolved PER BLOCK KIND from the user's
        // own words — so "昨日の夕食と今日の筋トレ" backdates the MEAL to yesterday
        // WITHOUT dragging the workout there too (and vice-versa). Each kind's date
        // is decided from its own phrase; null → today (safe default). When the day
        // is genuinely ambiguous for a kind (conflicting day words we can't safely
        // attribute), `ambiguous` is true → we DON'T auto-save that block; we ask
        // the user to confirm instead (anti-mis-record). A "correct" keeps its
        // original entry's date regardless (applyMealLog ignores `date` on update).
        const mealDate = resolveRelativeDateKeyForKind(trimmed, "meal");
        const workoutDate = resolveRelativeDateKeyForKind(trimmed, "workout");
        const sleepDate = resolveRelativeDateKeyForKind(trimmed, "sleep");

        const { context } = readTodayContext();
        // 1日まるごと自動プラン: on an explicit "plan my day" turn, READ the user's
        // existing calendar events so the coach can plan around them. FAIL-SOFT —
        // readTodayPlan returns { connected:false } when the calendar isn't linked
        // (the coach asks to connect, never invents events) and null on a read error
        // (the day-plan read is simply omitted; the coach still plans honestly). The
        // userId is server-derived from the session — never sent — so this reads
        // ONLY the caller's own calendar.
        const todayPlan = isDayPlanTurn ? await readTodayPlan() : null;
        // Attach the grounded photo analysis (presentation context for the coach)
        // only on the turn that carried a photo. The wire history is built from THIS
        // send's user turn (withUser), the synchronously-current message list.
        // A turn is EITHER a meal-log photo (mealAnalysis) OR a fridge→献立 photo
        // (fridgeAnalysis) — never both — so attach whichever this turn produced.
        // The day-plan read (todayPlan) is orthogonal and may ride alongside.
        const base = mealAnalysis
          ? { ...context, mealAnalysis }
          : fridgeAnalysis
            ? { ...context, fridgeAnalysis }
            : context;
        const ctx = todayPlan ? { ...base, todayPlan } : base;
        const rawReply = await sendChat(toWireMessages(withUser), ctx);

        // ---- 2. Parse the reply: strip any auto-log block(s), keep prose ----
        // A reply may carry a MEAL_LOG (photo-driven) OR a WORKOUT_LOG (text-
        // driven) block. Strip the meal block first, then scan its leftover prose
        // for a workout block, so neither sentinel can leak into the bubble.
        const { display: afterMeal, payload: mealPayload } = parseCoachReply(rawReply);
        const { display: afterWorkout, payload: workoutPayload } = parseWorkoutReply(afterMeal);
        // Strip the WORKOUT_PLAN block next (運動メニュー提案フロー). Its sentinel is
        // distinct from WORKOUT_LOG, so a reply that proposes a menu carries this one;
        // we always strip it so raw JSON never reaches the bubble, then apply it below
        // (bulk insert as `planned` + calendar reflection).
        const { display: afterPlan, payload: planPayload } = parseWorkoutPlanReply(afterWorkout);
        // Strip the MEAL_PLAN block next (食事メニュー提案フロー, AIプランナー 第3陣D —
        // the twin of WORKOUT_PLAN). Its sentinel is distinct from MEAL_LOG, so a
        // reply that proposes a 献立 carries this one; we always strip it so raw JSON
        // never reaches the bubble, then apply it below (bulk insert as `planned` +
        // optional calendar reflection).
        const { display: afterMealPlan, payload: mealPlanPayload } = parseMealPlanReply(afterPlan);
        // Strip the SLEEP block next so its sentinel can't leak into the bubble.
        const { display: afterSleep, payload: sleepPayload } = parseSleepReply(afterMealPlan);
        // Strip the CALENDAR_PLAN block LAST (chat→Googleカレンダー). Like the log
        // blocks, the sentinel is always removed from what the user sees; the
        // structured plan is forwarded to the calendar API below.
        const { display: afterCalendar, payload: calendarPayload } = parseCalendarReply(afterSleep);
        // Strip the DELETE_RECORD action last. The coach decides from natural
        // language + full chat context; the app validates against local data and
        // only then performs the actual delete through the same tombstone path as
        // the UI. The action block itself is never shown to the user.
        const deleteResult = resolveDeleteRequestFromCoachReply(afterCalendar, trimmed, {
          messages: withUser,
          meals: loadMeals(),
          workouts: loadWorkouts(),
          now: sentAt,
        });
        const { display } = deleteResult;
        const deleteRequest = deleteResult.request;

        if (deleteResult.handled) {
          const deleted = deleteRequest
            ? deleteRequest.kind === "meal"
              ? await deleteMealsFromChat(deleteRequest.ids)
              : deleteWorkoutExercisesFromChat(deleteRequest)
            : 0;
          const content =
            deleteRequest && deleted > 0
              ? deleteConfirmation({ ...deleteRequest, count: deleted })
              : "該当する記録が見つからなかったため、削除は行いませんでした。日付と種類（食事/運動）を指定してもう一度教えてください。";
          appendMessage({
            id: makeId(),
            role: "assistant",
            content,
            createdAt: new Date().toISOString(),
          });
          return;
        }

        // ---- 3. Auto-log (the critical part): re-ground + write -------------
        // The LOGGED numbers come from the grounded pipelines (meal: foodGrounding;
        // workout: burn/workoutSets), NEVER from the model's prose. Written client-
        // side via storage so it flows to 食事 / 筋トレ / dashboard (成果) / calendar.
        //
        // DE-DUPE (redesigned): the block's explicit `mode` decides. "new" always
        // appends a distinct entry (so a text-only "also log X" can't overwrite the
        // prior one — over-merge fixed). "correct" updates the most-recent logged
        // entry of that kind, resolved from the SEND-TIME snapshot (correctMealId /
        // correctWorkoutIds captured above; reload-safe; after clear() there's nothing
        // to correct → it safely appends). Snapshotting at send time (not here at
        // reply time) means a correction binds to the meal/workout that existed when
        // the user sent it, so an overlapping new-meal send can't steal the target.
        let loggedMeal: ChatMessage["loggedMeal"];
        // Track when a block was held back because its day was ambiguous, so the
        // bubble can ask the user to confirm instead of silently mis-recording.
        let ambiguousDate = false;
        // The distinct PAST days blocks actually landed on this turn, so the bubble
        // notes each backdate honestly (per block — a meal on 昨日 + a workout on
        // 今日 only notes the 昨日 one). Today is never added (no note needed).
        const backdatedDates = new Set<string>();
        // A backdated NEW meal targets the resolved past day; a correction keeps
        // its original date (applyMealLog ignores `date` on the update path).
        const mealIsNew = (mealPayload?.mode ?? "new") === "new";
        const mealTargetDate = mealIsNew ? (mealDate.dateKey ?? undefined) : undefined;
        // Hold back an ambiguous-day NEW meal (don't guess the wrong day). A
        // correction is exempt (it updates a known existing entry's own date).
        if (mealPayload && mealIsNew && mealDate.ambiguous) {
          ambiguousDate = true;
        } else if (mealPayload) {
          const applied = applyMealLog(mealPayload, {
            meals: loadMeals(),
            correctId: correctMealId,
            date: mealTargetDate,
            photoId,
            // CHANGE 3: tighten label/estimate numbers to the grounded analysis.
            analysis: mealAnalysis,
          });
          if (applied) {
            // Fill DB-miss (no-number 推定値) items with a real labelled AI estimate
            // at log-time, so a chat-logged food the official DB can't match
            // (カツオのタタキ / プロテイン) shows honest 推定値 numbers instead of 0 —
            // mirroring the /meal editor's auto-estimate. Anti-fabrication preserved
            // (numbers come from the shared analysis path; no key/offline → kept as-is).
            const enriched = await estimateLoggedMeal(applied.meals, applied.mealId);
            saveMeals(enriched);
            loggedMeal = { mealId: applied.mealId, itemCount: applied.itemCount };
            if (mealTargetDate) backdatedDates.add(mealTargetDate);
          }
        }

        let loggedWorkout: ChatMessage["loggedWorkout"];
        const workoutIsNew = (workoutPayload?.mode ?? "new") === "new";
        const workoutTargetDate = workoutIsNew ? (workoutDate.dateKey ?? undefined) : undefined;
        if (workoutPayload && workoutIsNew && workoutDate.ambiguous) {
          ambiguousDate = true; // hold back the ambiguous-day NEW workout; ask to confirm
        } else if (workoutPayload) {
          const applied = applyWorkoutLog(workoutPayload, {
            workouts: loadWorkouts(),
            correctIds: correctWorkoutIds,
            date: workoutTargetDate,
          });
          if (applied) {
            saveWorkouts(applied.workouts);
            loggedWorkout = {
              exerciseIds: applied.exerciseIds,
              date: applied.date,
              exerciseCount: applied.exerciseCount,
            };
            if (workoutTargetDate) backdatedDates.add(workoutTargetDate);
          }
        }

        // ---- 3b'. Workout PLAN (chat→運動メニュー提案, AIプランナー 第2陣C) --------
        // A confirmed WORKOUT_PLAN bulk-inserts the proposed moves into TODAY's
        // 運動 as `status:"planned"` (they show with a 完了 button but don't count
        // toward 成果/消費kcal until completed). When the plan carries a session
        // start/end, we ALSO reflect it onto the calendar via the EXISTING path.
        // A plan is always TODAY (the「今日の運動メニュー」flow) — no relative-date.
        let plannedWorkout: ChatMessage["plannedWorkout"];
        let planCalendarPayload: ReturnType<typeof planToCalendarPayload> = null;
        if (planPayload) {
          const applied = applyWorkoutPlan(planPayload, {
            workouts: loadWorkouts(),
            correctIds: correctPlannedIds,
          });
          if (applied) {
            saveWorkouts(applied.workouts);
            plannedWorkout = {
              exerciseIds: applied.exerciseIds,
              date: applied.date,
              exerciseCount: applied.exerciseCount,
            };
            // Build the calendar reflection (one トレーニング event) from the
            // session time, if the plan carried a valid one. Sent below alongside
            // any other CALENDAR_PLAN the coach emitted (both go to the same API).
            planCalendarPayload = planToCalendarPayload(planPayload, {
              timeZone: calendarTimeZone(),
            });
          }
        }

        // ---- 3b''. Meal PLAN (chat→食事メニュー提案, AIプランナー 第3陣D) ------------
        // A confirmed MEAL_PLAN bulk-inserts the proposed 献立 into TODAY's 食事 as
        // `status:"planned"` (they show with a 「食べた」 button but don't count toward
        // 摂取/PFC/達成 until the user marks each eaten — sumIntake excludes planned).
        // When a planned meal carries start/end, we ALSO reflect it onto the calendar
        // via the EXISTING path (one 食事 event each). A plan is always TODAY (the
        //「今日の献立」flow) — no relative-date. The exact twin of the workout plan above.
        let plannedMeal: ChatMessage["plannedMeal"];
        let mealPlanCalendarPayload: ReturnType<typeof mealPlanToCalendarPayload> = null;
        if (mealPlanPayload) {
          const applied = applyMealPlan(mealPlanPayload, {
            meals: loadMeals(),
            correctIds: correctPlannedMealIds,
          });
          if (applied) {
            saveMeals(applied.meals);
            plannedMeal = {
              mealIds: applied.mealIds,
              date: applied.date,
              mealCount: applied.mealCount,
            };
            // Build the calendar reflection (one 食事 event per timed meal) from the
            // planned times, if any. Sent below alongside any other CALENDAR_PLAN.
            mealPlanCalendarPayload = mealPlanToCalendarPayload(mealPlanPayload, {
              timeZone: calendarTimeZone(),
            });
          }
        }

        // ---- 3c. Sleep auto-log (chat→睡眠, 拡張②) ---------------------------
        // One doc/day: a confirmed 就寝/起床 pair upserts the day's sleep record.
        // The LENGTH is derived by the store (overnight-aware), never the model.
        // A relative-date phrase ("昨日の分") targets that past day (resolved from
        // the sleep phrase only); else today. An ambiguous day holds the block back.
        let loggedSleep = false;
        if (sleepPayload && sleepDate.ambiguous) {
          ambiguousDate = true; // hold back the ambiguous-day sleep; ask to confirm
        } else if (sleepPayload) {
          const applied = applySleepLog(sleepPayload, {
            sleep: loadSleepLogs(),
            date: sleepDate.dateKey ?? undefined,
          });
          saveSleepLogs(applied.sleep);
          loggedSleep = true;
          if (sleepDate.dateKey) backdatedDates.add(sleepDate.dateKey);
        }

        // RECORDING-RELIABILITY GUARD (the "if it says 記録しました, it IS recorded"
        // guarantee). The coach may write a completed-save claim in prose
        // ("登録しておきました") but emit NO block — or a malformed one that grounds to
        // nothing — so nothing was actually saved. `recorded` is the GROUND TRUTH:
        // a meal OR workout record was really produced this turn. When the prose
        // claims a save but `recorded` is false, reconcileLogClaim appends an honest
        // notice so the user is never falsely told it was logged; the chip below is
        // ALSO gated on `recorded`, so the chip can only appear when a record exists.
        // We never fabricate a record to satisfy the claim (no calorie invention) —
        // we make the message honest instead.
        const recorded =
          Boolean(loggedMeal) ||
          Boolean(loggedWorkout) ||
          Boolean(plannedWorkout) ||
          Boolean(plannedMeal) ||
          loggedSleep;
        const baseProse =
          display.trim() ||
          "内容を確認しました。対象が分からない場合は、日付・種類・範囲を指定してもう一度教えてください。";
        let honestProse = reconcileLogClaim(baseProse, recorded);
        // Feature ②: when a record actually landed on a PAST day, append an honest
        // note per backdated day so the user can see it wasn't logged to today. With
        // per-block dates a meal on 昨日 + a workout on 今日 notes only the 昨日 one.
        for (const dateKey of backdatedDates) {
          const note = backdatedNote(dateKey);
          if (note) honestProse = `${honestProse}\n\n${note}`;
        }
        // Major-2 fix: a block was held back because its day was ambiguous — tell the
        // user it wasn't saved and how to disambiguate, instead of mis-recording it.
        if (ambiguousDate) {
          honestProse = `${honestProse}\n\n${ambiguousDateNote()}`;
        }

        // ---- 3d. Calendar plan (chat→Googleカレンダー) -----------------------
        // A confirmed CALENDAR_PLAN block creates events on the user's OWN Google
        // Calendar (server-side, via the Worker, with the user's stored token).
        // The result is appended as an HONEST note: not-connected / created N /
        // partial / failed — we never claim a calendar write that didn't happen
        // (mirrors the recording-reliability guard above). A failure here never
        // breaks the chat reply; the prose still shows.
        // The session time from a confirmed WORKOUT_PLAN rides the SAME calendar
        // path as a CALENDAR_PLAN block — merge their items into one call so a "menu
        // ＋ put it on my calendar" turn makes a single calendar request. Either may
        // be present alone.
        // Merge ALL three calendar sources (a CALENDAR_PLAN block + the workout-plan
        // session reflection + the meal-plan meal reflections) into ONE call so a
        // "1日プランしてカレンダーにも入れて" turn makes a single calendar request.
        const calendarToSend = mergeCalendarPayloads(
          mergeCalendarPayloads(calendarPayload, planCalendarPayload),
          mealPlanCalendarPayload,
        );
        if (calendarToSend) {
          try {
            const outcome = await runCalendarPlan(calendarToSend);
            if (outcome.note) honestProse = `${honestProse}\n\n${outcome.note}`;
          } catch {
            honestProse = `${honestProse}\n\n（カレンダーへの登録時にエラーが発生しました。少し時間をおいてお試しください。）`;
          }
        }
        const assistantMsg: ChatMessage = {
          id: makeId(),
          role: "assistant",
          // Always the stripped + reconciled prose — raw JSON never reaches the
          // bubble, and a false "recorded" claim is corrected to be honest.
          content: honestProse,
          createdAt: new Date().toISOString(),
          ...(loggedMeal ? { loggedMeal } : {}),
          ...(loggedWorkout ? { loggedWorkout } : {}),
          ...(plannedWorkout ? { plannedWorkout } : {}),
          ...(plannedMeal ? { plannedMeal } : {}),
        };
        // Synchronous append again: the reply is persisted (saveChat) inside
        // appendMessage from the provider, which stays mounted across navigation — so
        // the coach's reply sticks even if the user left the chat view while it was in
        // flight, and reads from the always-current ref under overlapping sends.
        appendMessage(assistantMsg);
      } catch (e) {
        // Honest failure: keep the user turn, surface the error, never fabricate.
        setError(e instanceof Error ? e.message : "返信を取得できませんでした");
      } finally {
        inflightRef.current = Math.max(0, inflightRef.current - 1);
        setInflight((n) => {
          const next = n - 1;
          if (next <= 0) {
            setPhase("idle");
            setPhotoCount(0);
          }
          return next;
        });
      }
    },
    [appendMessage],
  );

  const clear = useCallback(() => {
    setMessages([]);
    messagesRef.current = [];
    setError(null);
    clearChat();
  }, []);

  const value: UseChat = {
    messages,
    profile,
    coachSettings,
    ready,
    sending: inflight > 0,
    phase,
    photoCount,
    error,
    hasKey,
    send,
    clear,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/** Read the shared chat state + send logic. Throws if used outside the provider. */
export function useChat(): UseChat {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChat must be used within ChatProvider");
  }
  return ctx;
}

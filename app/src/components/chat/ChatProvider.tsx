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
  saveChat,
  toWireMessages,
  type ChatMessage,
} from "@/lib/chatStore";
import {
  buildChatContext,
  buildLoggedMealItems,
  buildLoggedWorkoutItems,
  sendChat,
  type ChatMealAnalysis,
} from "@/lib/chat";
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
import { calcTargets } from "@/lib/nutrition";
import { sumIntake } from "@/lib/intake";
import { workoutBurn } from "@/lib/burn";
import { toDateKey, makeId, formatTime, formatNowText } from "@/lib/date";
import type { LoggedMealTime } from "@/lib/chat";
import { compressImage } from "@/lib/image";
import { putPhoto } from "@/lib/photoStore";
import { parseCoachReply } from "@/lib/mealLogProtocol";
import { parseWorkoutReply } from "@/lib/workoutLogProtocol";
import {
  analysisToChatContext,
  applyMealLog,
  lastLoggedMealId,
  NON_FOOD_ANALYSIS,
} from "@/lib/chatMealLog";
import { estimateLoggedMeal } from "@/lib/chatMealEstimate";
import {
  resolveSameAsYesterday,
  sameAsYesterdayConfirmation,
} from "@/lib/sameAsYesterday";
import {
  ambiguousDateNote,
  backdatedNote,
  resolveRelativeDateKeyForKind,
} from "@/lib/relativeDate";
import { applyWorkoutLog, lastLoggedWorkoutIds } from "@/lib/chatWorkoutLog";
import { parseSleepReply } from "@/lib/sleepLogProtocol";
import { applySleepLog } from "@/lib/chatSleepLog";
import { reconcileLogClaim } from "@/lib/logClaim";
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
    .filter((m) => typeof m.timestamp === "string" && m.timestamp)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const time = formatTime(m.timestamp);
    if (time !== null) loggedMeals.push({ type: m.type, time });
  }
  const loggedWorkoutTime =
    exercises.length > 0 && workout?.updatedAt
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
      coach,
    }),
  };
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
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // The provider persists across route changes (mounted above the page children), so
  // it no longer re-reads these on remount. Editing the coach/profile on /profile then
  // navigating back to /chat would otherwise show stale values. Re-read the lightweight
  // localStorage values on every client navigation — cheap, and messages are NOT
  // touched so the persistence fix stays intact.
  useEffect(() => {
    setHasKey(hasApiKey());
    setCoachSettings(loadCoachSettings());
    setProfile(loadProfile());
  }, [pathname]);

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

      // ---- 1. Photo(s) (optional): compress + store all, analyse as ONE meal -
      // Each photo is stored in IndexedDB so the user's bubble + the logged meal
      // keep the pictures. ALL photos go into a SINGLE analyzeMeal call so the
      // model sees the whole meal together and returns one combined, grounded
      // item list (the merge happens in the model, not by stitching here).
      const photoIds: string[] = [];
      let mealAnalysis: ChatMealAnalysis | undefined;
      const hasPhotos = photoList.length > 0;
      // Mark this send in flight up-front so the indicator shows immediately and
      // the count is balanced in the finally below.
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
            // EXISTING analyzeMeal → grounded MealNutrition (DB/label/estimate),
            // now over the whole set of photos in one grounded call.
            const nutrition = await analyzeMeal({ imageBase64List });
            mealAnalysis = analysisToChatContext(nutrition);
          } catch {
            // The photo(s) couldn't be analysed as food (non-food, unreadable, or
            // the analyzer failed). Tell the coach to handle it gracefully — never
            // fabricate a meal from photos we couldn't ground.
            mealAnalysis = NON_FOOD_ANALYSIS;
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
          createdAt: new Date().toISOString(),
          ...(photoId ? { photoId } : {}),
          ...(photoIds.length > 1 ? { photoIds } : {}),
        };
        // Synchronous append via the ref so two overlapping sends never clobber each
        // other's user turn; persist + mirror happen inside appendMessage, NOT inside
        // a setMessages updater.
        const withUser = appendMessage(userMsg);

        // ---- 1b. "昨日と同じ量" shortcut (deterministic, no LLM round-trip) ----
        // When the user says "log the same as yesterday" for a meal slot, the coach
        // (which only sees TODAY's data) used to re-ask for grams and never record it.
        // Instead, reuse YESTERDAY's actual logged meal for that slot: copy its items
        // + grams + kcal/PFC verbatim and log it for today, WITHOUT re-asking. This is
        // a TEXT-only intent (no photo); if yesterday genuinely has no record for the
        // slot, resolveSameAsYesterday returns null → we fall through to the normal
        // coach path (which then asks). Nothing is fabricated — the numbers are
        // yesterday's own grounded record.
        if (!hasPhotos) {
          const reuse = resolveSameAsYesterday(trimmed, loadMeals());
          if (reuse) {
            saveMeals([...loadMeals(), reuse.meal]);
            const itemCount = reuse.meal.nutrition?.items?.length ?? 0;
            appendMessage({
              id: makeId(),
              role: "assistant",
              content: sameAsYesterdayConfirmation(reuse),
              createdAt: new Date().toISOString(),
              loggedMeal: { mealId: reuse.meal.id, itemCount },
            });
            return; // logged directly — skip the LLM call entirely
          }
        }

        // Snapshot the correction targets NOW (at send time), from the array that
        // existed when this user turn was added. This binds any correction to the
        // meal/workout that existed when the user sent it — so an overlapping
        // new-meal send can't steal the correction target by the time the reply lands.
        const correctMealId = lastLoggedMealId(withUser);
        const correctWorkoutIds = lastLoggedWorkoutIds(withUser);

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
        // Attach the grounded photo analysis (presentation context for the coach)
        // only on the turn that carried a photo. The wire history is built from THIS
        // send's user turn (withUser), the synchronously-current message list.
        const ctx = mealAnalysis ? { ...context, mealAnalysis } : context;
        const rawReply = await sendChat(toWireMessages(withUser), ctx);

        // ---- 2. Parse the reply: strip any auto-log block(s), keep prose ----
        // A reply may carry a MEAL_LOG (photo-driven) OR a WORKOUT_LOG (text-
        // driven) block. Strip the meal block first, then scan its leftover prose
        // for a workout block, so neither sentinel can leak into the bubble.
        const { display: afterMeal, payload: mealPayload } = parseCoachReply(rawReply);
        const { display: afterWorkout, payload: workoutPayload } = parseWorkoutReply(afterMeal);
        // Strip the SLEEP block last so its sentinel can't leak into the bubble either.
        const { display, payload: sleepPayload } = parseSleepReply(afterWorkout);

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
        const recorded = Boolean(loggedMeal) || Boolean(loggedWorkout) || loggedSleep;
        const baseProse = display || rawReply;
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
        const assistantMsg: ChatMessage = {
          id: makeId(),
          role: "assistant",
          // Always the stripped + reconciled prose — raw JSON never reaches the
          // bubble, and a false "recorded" claim is corrected to be honest.
          content: honestProse,
          createdAt: new Date().toISOString(),
          ...(loggedMeal ? { loggedMeal } : {}),
          ...(loggedWorkout ? { loggedWorkout } : {}),
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

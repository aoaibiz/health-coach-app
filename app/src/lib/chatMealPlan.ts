// Chat→食事メニュー提案フロー applier (AIプランナー 第3陣D). The twin of
// chatWorkoutPlan.ts, but for a 献立 PLAN (future intent) the user confirmed, not a
// record of what they ate. Three pure steps, all unit-testable with no DOM/network:
//   1. applyMealPlan — bulk-insert the proposed meals into TODAY's 食事 as
//      `status:"planned"`, with the SAME new/correct de-dupe as the workout-plan
//      path (so a "correct" replaces the last planned batch, not an eaten one). Each
//      meal's nutrition is grounded by the SAME buildLoggedMeal path as the meal
//      log, so a planned meal is byte-identical to a logged one except its status +
//      its (optional) recipe card — then 「食べた」 (status→eaten) flips it and it
//      starts counting toward 摂取/PFC/達成.
//   2. lastPlannedMealIds — resolve the planned ids the chat last inserted from
//      PERSISTED history (the targets a "correct" replaces).
//   3. mealPlanToCalendarPayload — when a planned meal carries start/end, build a
//      CALENDAR_PLAN payload (one 食事 event each) so the EXISTING calendar path
//      reflects them onto the user's Google Calendar (no new write channel).
//
// FABRICATION SAFETY: this is a CONFIRMED proposal, not a measurement. Inserting
// the meals as `planned` keeps 摂取/履歴 truthful (sumIntake / the dashboard /
// coachContext all exclude planned) until the user marks each eaten. The kcal/PFC
// that EVENTUALLY count come from buildLoggedMeal's grounded pipeline, never the
// model. The recipe card is presentation-only — it is never read as a number.

import type { Meal, MealType } from "./types";
import { buildLoggedMeal } from "./chatMealLog";
import { toDateKey } from "./date";
import type { MealPlanItem, MealPlanPayload } from "./mealPlanProtocol";
import type {
  CalendarPlanItem,
  CalendarPlanPayload,
} from "./calendarPlanProtocol";

/**
 * The result of applying one MEAL_PLAN payload against the meal store. `meals` is
 * the next store array to persist; `mealIds` are the ids of the planned meals this
 * turn inserted (recorded on the assistant chat message so a later "correct" plan
 * can resolve + replace them). `date` is the day they were planned to (today).
 * `mealCount` backs the "献立を◯件プランしました" chip.
 */
export interface ApplyMealPlanResult {
  meals: Meal[];
  mealIds: string[];
  date: string;
  mealCount: number;
}

/** Build ONE planned Meal from a MealPlanItem: ground its items via the SAME
 *  buildLoggedMeal path as the log, then stamp it `planned` + attach the recipe
 *  card. Returns null when nothing groundable remains (so an empty plan meal is
 *  dropped, never inserted). `id` lets a "correct" keep the planned meal's id. */
function buildPlannedMeal(
  meal: MealPlanItem,
  opts: { id?: string; date: string; now: Date },
): Meal | null {
  const built = buildLoggedMeal(
    { items: meal.items, type: meal.type ?? ("昼" as MealType) },
    { id: opts.id, date: opts.date, now: opts.now },
  );
  if (!built) return null;
  return {
    ...built,
    status: "planned",
    ...(meal.recipe ? { recipe: meal.recipe } : {}),
  };
}

/**
 * Apply ONE MEAL_PLAN payload with EXPLICIT, PERSISTENT de-dupe — the 食事 twin of
 * applyWorkoutPlan. The meals are inserted into TODAY's 食事 as `status:"planned"`:
 *
 *   - mode "new" (default): APPEND the planned meals as a distinct batch.
 *   - mode "correct": REPLACE the meals this chat last PLANNED (identified by
 *     `correctIds`, resolved by the caller from the assistant message that carried
 *     `plannedMeal`) with the freshly proposed ones, keeping ids where possible.
 *     A "correct" whose targets are all gone (the user deleted/ate them) safely
 *     APPENDS — no ghost update.
 *
 * Plans go to TODAY only (the spec's「今日の献立」). 「食べた」 later flips a planned
 * entry to eaten via the normal updateMeal on the 食事 page.
 *
 * Returns null when nothing groundable remains.
 */
export function applyMealPlan(
  payload: MealPlanPayload,
  opts: {
    meals: Meal[];
    /** Ids of the meals this chat last PLANNED (for mode "correct"). */
    correctIds?: string[] | null;
    date?: string;
    now?: Date;
  },
): ApplyMealPlanResult | null {
  const date = opts.date ?? toDateKey();
  const now = opts.now ?? new Date();
  const mode = payload.mode ?? "new";

  const correctIds = mode === "correct" && opts.correctIds ? opts.correctIds : [];
  // A "correct" only replaces in place when at least one target still exists in the
  // store AND is still a plan; otherwise it APPENDS (no ghost update of an eaten /
  // deleted meal). We reuse the surviving target ids in order so the planned
  // entries keep identity across the update (calendar/sync parity).
  const presentTargetIds = correctIds.filter((id) =>
    opts.meals.some((m) => m.id === id && m.status === "planned"),
  );
  const targetsPresent = presentTargetIds.length > 0;

  // Ground every proposed meal (kcal/PFC from buildLoggedMeal, never the model),
  // reusing ids on a correct so the planned entries keep identity across the update.
  const fresh: Meal[] = [];
  for (let i = 0; i < payload.meals.length; i++) {
    const reuseId = targetsPresent ? presentTargetIds[i] : undefined;
    const built = buildPlannedMeal(payload.meals[i], {
      ...(reuseId ? { id: reuseId } : {}),
      date,
      now,
    });
    if (built) fresh.push(built);
  }
  if (fresh.length === 0) return null;

  let nextMeals: Meal[];
  if (targetsPresent) {
    // Drop the previously-planned batch, then append the regrounded one (so a
    // correction that changes the COUNT doesn't leave orphan plans).
    nextMeals = [
      ...opts.meals.filter((m) => !correctIds.includes(m.id)),
      ...fresh,
    ];
  } else {
    nextMeals = [...opts.meals, ...fresh];
  }

  return {
    meals: nextMeals,
    mealIds: fresh.map((m) => m.id),
    date,
    mealCount: fresh.length,
  };
}

/**
 * Resolve the planned meal ids the chat last inserted from the PERSISTED chat
 * history — the targets a "correct" plan replaces. Scans newest-first for an
 * assistant turn carrying `plannedMeal` and returns its mealIds, or null when none.
 * Pure + reload-safe by construction (mirrors lastPlannedWorkoutIds).
 */
export function lastPlannedMealIds(
  messages: ReadonlyArray<{
    role: string;
    plannedMeal?: { mealIds: string[] } | undefined;
  }>,
): string[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.plannedMeal?.mealIds?.length) {
      return m.plannedMeal.mealIds;
    }
  }
  return null;
}

/** Map a meal slot to a friendly default 食事 event title for the calendar. */
const SLOT_TITLE: Record<MealType, string> = {
  朝: "朝食",
  昼: "昼食",
  夕: "夕食",
  間食: "間食",
};

/**
 * Build a CALENDAR_PLAN payload (one 食事 event PER planned meal that carries a
 * valid time) from a meal plan, so the EXISTING calendar path (runCalendarPlan)
 * can reflect them onto the user's Google Calendar. Returns null when NO planned
 * meal carried a valid start/end (the calendar step is simply skipped — the plan
 * still inserts into 食事). The times are the model's validated zone-aware ISO8601
 * (mealPlanProtocol already dropped bad/zoneless/inverted times), so nothing is
 * invented here. Each event's notes list the planned items compactly for context.
 */
export function mealPlanToCalendarPayload(
  payload: MealPlanPayload,
  opts?: { timeZone?: string },
): CalendarPlanPayload | null {
  const items: CalendarPlanItem[] = [];
  for (const meal of payload.meals) {
    if (!meal.start || !meal.end) continue;
    const names = meal.items
      .map((it) => it.name.trim())
      .filter((n) => n.length > 0);
    const slot: MealType = meal.type ?? "昼";
    items.push({
      type: "食事",
      title: SLOT_TITLE[slot],
      start: meal.start,
      end: meal.end,
      ...(names.length > 0 ? { notes: names.join("・") } : {}),
    });
  }
  if (items.length === 0) return null;
  return {
    items,
    ...(opts?.timeZone ? { timeZone: opts.timeZone } : {}),
  };
}

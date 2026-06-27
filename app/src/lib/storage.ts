// localStorage persistence for meals and workouts.
// Photos themselves live in IndexedDB (see photoStore.ts); meals only keep a photoId.
//
// DURABILITY (Stage 2): localStorage remains the fast local cache + source of
// truth, but every save now ALSO pushes to the authenticated server API
// (best-effort, retried) so a browser clear / device switch can't lose data.
// The push is fire-and-forget and never throws — local is written FIRST and is
// never discarded on a failed/empty server response (see syncData.ts, the #1
// rule). When the user is logged out the push is a silent no-op (local-only,
// exactly as before).

import type { Meal, Profile, Workout } from "./types";
import { pruneGeneratedMealImageDataUrls } from "./mealCardImage";
import { pushSectionBestEffort } from "./syncData";
import { clearTombstones } from "./deletionsStore";

const MEALS_KEY = "health-app:meals:v1";
const WORKOUTS_KEY = "health-app:workouts:v1";
const PROFILE_KEY = "health-app:profile:v1";

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

// ---- Meals -----------------------------------------------------------------

export function loadMeals(): Meal[] {
  return readJSON<Meal[]>(MEALS_KEY, []);
}

export function saveMeals(meals: Meal[]): void {
  const syncSafeMeals = pruneGeneratedMealImageDataUrls(meals);
  writeJSON(MEALS_KEY, syncSafeMeals);
  // A re-added id supersedes any old tombstone for it (writes a synced `cleared`
  // op), so a re-creation isn't re-suppressed by the merge. (A sync write of the
  // tombstone-excluded union contains no tombstoned ids, so this is a no-op.)
  // When something WAS revived, push `deletions` too so the cleared op reaches the
  // server — otherwise another device keeps the old `deleted` op and re-suppresses
  // the revived record (Codex review).
  const revived = clearTombstones("meals", syncSafeMeals.map((m) => m.id).filter(Boolean) as string[]);
  if (revived) pushSectionBestEffort("deletions");
  // Best-effort server backup (no-op when logged out; never throws).
  pushSectionBestEffort("meals");
}

// ---- Workouts --------------------------------------------------------------

export function loadWorkouts(): Record<string, Workout> {
  return readJSON<Record<string, Workout>>(WORKOUTS_KEY, {});
}

export function saveWorkouts(workouts: Record<string, Workout>): void {
  writeJSON(WORKOUTS_KEY, workouts);
  // Clear exercise tombstones for any exercise id now present (a re-added exercise
  // supersedes its old tombstone). No-op for a sync write of the excluded union.
  const presentExerciseIds: string[] = [];
  for (const day of Object.values(workouts)) {
    for (const e of day?.exercises ?? []) if (e?.id) presentExerciseIds.push(e.id);
  }
  const revived = clearTombstones("workouts", presentExerciseIds);
  if (revived) pushSectionBestEffort("deletions"); // propagate the cleared op too.
  pushSectionBestEffort("workouts");
}

// ---- Profile ---------------------------------------------------------------

/** The owner's profile, or null when not yet set up. */
export function loadProfile(): Profile | null {
  return readJSON<Profile | null>(PROFILE_KEY, null);
}

export function saveProfile(profile: Profile): void {
  writeJSON(PROFILE_KEY, profile);
  pushSectionBestEffort("profile");
}

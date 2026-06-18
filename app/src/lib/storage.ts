// localStorage persistence for meals and workouts.
// Photos themselves live in IndexedDB (see photoStore.ts); meals only keep a photoId.

import type { Meal, Profile, Workout } from "./types";

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
  writeJSON(MEALS_KEY, meals);
}

// ---- Workouts --------------------------------------------------------------

export function loadWorkouts(): Record<string, Workout> {
  return readJSON<Record<string, Workout>>(WORKOUTS_KEY, {});
}

export function saveWorkouts(workouts: Record<string, Workout>): void {
  writeJSON(WORKOUTS_KEY, workouts);
}

// ---- Profile ---------------------------------------------------------------

/** The owner's profile, or null when not yet set up. */
export function loadProfile(): Profile | null {
  return readJSON<Profile | null>(PROFILE_KEY, null);
}

export function saveProfile(profile: Profile): void {
  writeJSON(PROFILE_KEY, profile);
}

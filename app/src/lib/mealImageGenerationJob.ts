import { generateMealImage, type GenerateMealImageOptions } from "./analyzeMeal";

const pendingMealImageGenerations = new Map<string, Promise<Blob>>();
const pendingMealImageApplications = new Map<string, Promise<unknown>>();
const pendingMealImageApplicationPromptCounts = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

function emitChange(): void {
  snapshotVersion += 1;
  listeners.forEach((listener) => listener());
}

function jobKey(text: string, endpoint?: string): string {
  return `${endpoint ?? "/api/generate-meal-image"}\n${text.trim()}`;
}

function applicationJobKey(mealId: string, promptText: string): string {
  return `${mealId}\n${promptText.trim()}`;
}

function bumpApplicationPrompt(promptText: string, delta: 1 | -1): void {
  const current = pendingMealImageApplicationPromptCounts.get(promptText) ?? 0;
  const next = current + delta;
  if (next <= 0) pendingMealImageApplicationPromptCounts.delete(promptText);
  else pendingMealImageApplicationPromptCounts.set(promptText, next);
}

export function hasPendingMealImageGeneration(text: string, endpoint?: string): boolean {
  const trimmed = text.trim();
  return Boolean(
    trimmed &&
      (pendingMealImageGenerations.has(jobKey(trimmed, endpoint)) ||
        pendingMealImageApplicationPromptCounts.has(trimmed)),
  );
}

export function hasAnyPendingMealImageGeneration(): boolean {
  return pendingMealImageGenerations.size > 0 || pendingMealImageApplications.size > 0;
}

export function getMealImageGenerationSnapshot(): number {
  return snapshotVersion;
}

export function subscribeMealImageGenerationJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetMealImageGenerationJobsForTest(): void {
  if (pendingMealImageGenerations.size > 0 || pendingMealImageApplications.size > 0) {
    pendingMealImageGenerations.clear();
    pendingMealImageApplications.clear();
    pendingMealImageApplicationPromptCounts.clear();
    emitChange();
  }
}

/**
 * Share one browser-side generation request across page remounts. A route change
 * should not start duplicate Codex image jobs for the same menu prompt.
 */
export function generateMealImageOnce(
  input: { text: string },
  options: GenerateMealImageOptions = {},
): Promise<Blob> {
  const text = input.text.trim();
  if (!text) return generateMealImage(input, options);

  const key = jobKey(text, options.endpoint);
  const pending = pendingMealImageGenerations.get(key);
  if (pending) return pending;

  const promise = generateMealImage({ text }, options).finally(() => {
    if (pendingMealImageGenerations.get(key) === promise) {
      pendingMealImageGenerations.delete(key);
      emitChange();
    }
  });
  pendingMealImageGenerations.set(key, promise);
  emitChange();
  return promise;
}

/**
 * Keep the "generation is pending" lifecycle alive through the full browser-side
 * apply phase (generate -> compress -> IndexedDB/localStorage save). Without this,
 * a page remount between fetch resolution and save completion can start a second
 * job for the same meal/prompt.
 */
export function runMealImageApplicationOnce<T>(
  input: { mealId: string; promptText: string },
  work: () => Promise<T>,
): Promise<T> {
  const promptText = input.promptText.trim();
  if (!input.mealId || !promptText) return work();

  const key = applicationJobKey(input.mealId, promptText);
  const pending = pendingMealImageApplications.get(key);
  if (pending) return pending as Promise<T>;

  bumpApplicationPrompt(promptText, 1);
  const promise = work().finally(() => {
    if (pendingMealImageApplications.get(key) === promise) {
      pendingMealImageApplications.delete(key);
      bumpApplicationPrompt(promptText, -1);
      emitChange();
    }
  });
  pendingMealImageApplications.set(key, promise);
  emitChange();
  return promise;
}

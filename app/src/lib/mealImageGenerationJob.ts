import { generateMealImage, type GenerateMealImageOptions } from "./analyzeMeal";

const pendingMealImageGenerations = new Map<string, Promise<Blob>>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

function emitChange(): void {
  snapshotVersion += 1;
  listeners.forEach((listener) => listener());
}

function jobKey(text: string, endpoint?: string): string {
  return `${endpoint ?? "/api/generate-meal-image"}\n${text.trim()}`;
}

export function hasPendingMealImageGeneration(text: string, endpoint?: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed && pendingMealImageGenerations.has(jobKey(trimmed, endpoint)));
}

export function hasAnyPendingMealImageGeneration(): boolean {
  return pendingMealImageGenerations.size > 0;
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
  if (pendingMealImageGenerations.size > 0) {
    pendingMealImageGenerations.clear();
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

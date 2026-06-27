export const DATA_CHANGED_EVENT = "health-app:data-changed";

export function recordDeletion(_section: string, _id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DATA_CHANGED_EVENT));
}

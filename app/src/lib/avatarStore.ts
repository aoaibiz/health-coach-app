// Profile-avatar persistence. Reuses the exact same IndexedDB photo store as
// meal photos (photoStore.ts) — the blob lives in IndexedDB, and only a string
// id ref is kept on the Profile in localStorage. This keeps the static export
// intact (no server) and mirrors the meal-photo pattern.
//
// Split out from the component so the put/get/delete + id round-trip is
// unit-testable against an IndexedDB shim.

import { deletePhoto, getPhoto, putPhoto } from "./photoStore";
import { makeId } from "./date";

/** Avatar ids are namespaced so they're easy to spot but share the photo store. */
export function makeAvatarId(): string {
  return `avatar-${makeId()}`;
}

/** Store an avatar blob under a fresh id and return that id. */
export async function putAvatar(blob: Blob): Promise<string> {
  const id = makeAvatarId();
  await putPhoto(id, blob);
  return id;
}

/** Read an avatar blob by id, or null if missing. */
export function getAvatar(id: string): Promise<Blob | null> {
  return getPhoto(id);
}

/** Delete an avatar blob by id (best-effort; ignore if already gone). */
export function deleteAvatar(id: string): Promise<void> {
  return deletePhoto(id);
}

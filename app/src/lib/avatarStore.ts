// Profile-avatar persistence. Reuses the exact same IndexedDB photo store as
// meal photos (photoStore.ts) — the blob lives in IndexedDB, and only a string
// id ref is kept on the Profile in localStorage. This keeps the static export
// intact (no server) and mirrors the meal-photo pattern.
//
// Split out from the component so the put/get/delete + id round-trip is
// unit-testable against an IndexedDB shim.

import { deletePhoto, getPhoto, putPhoto } from "./photoStore";
import { makeId } from "./date";
import type { Profile } from "./types";

/**
 * Resolve the avatar image URL to render for a profile, preferring the SYNCED
 * data: URL (avatarDataUrl — follows the user across devices) and falling back
 * to the legacy device-local IndexedDB blob (avatarPhotoId) for profiles saved
 * before the cross-device change. Returns:
 *   - { url, revoke: false } when the synced data URL is used (nothing to revoke);
 *   - { url, revoke: true }  when an object URL was created from a blob (the
 *     caller MUST URL.revokeObjectURL(url) on cleanup);
 *   - null when there is no avatar.
 * Browser-only (creates object URLs). SSR-safe-ish: returns the data URL without
 * touching IndexedDB when only avatarDataUrl is present.
 */
export async function resolveAvatarUrl(
  profile: Pick<Profile, "avatarDataUrl" | "avatarPhotoId"> | null | undefined,
): Promise<{ url: string; revoke: boolean } | null> {
  if (!profile) return null;
  if (profile.avatarDataUrl) return { url: profile.avatarDataUrl, revoke: false };
  if (profile.avatarPhotoId) {
    const blob = await getAvatar(profile.avatarPhotoId);
    if (blob) return { url: URL.createObjectURL(blob), revoke: true };
  }
  return null;
}

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

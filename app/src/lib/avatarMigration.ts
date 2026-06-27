// One-time migration of LEGACY device-local avatars into their SYNCED home.
//
// WHY THIS EXISTS: early profiles AND coach settings stored the avatar as an
// IndexedDB blob ref (`avatarPhotoId`, see photoStore.ts). That blob lives only
// on the device it was saved on, so the avatar "disappeared" after a device
// switch. New saves embed the image as a compact data: URL (`avatarDataUrl`)
// which rides the synced profile / coachSettings blob. Existing users who never
// re-picked their photo still have ONLY the legacy ref, so their avatar still
// doesn't cross devices.
//
// THIS MODULE bridges that gap for BOTH avatars: when, after the login merge,
// the record has a legacy `avatarPhotoId` but NO synced `avatarDataUrl`, read
// the IndexedDB blob, compress it to a bounded data: URL, write it onto the
// record (dropping the dead legacy ref), and push the section so the avatar
// follows the user. Meal photos are deliberately OUT of scope (large; stay
// device-local).
//
// Idempotent + best-effort: a record that already has a data URL, has no legacy
// ref, or whose blob can't be read/compressed is left untouched and the function
// resolves quietly. SSR-safe (no-op without window).

import { loadProfile, saveProfile } from "./storage";
import { loadCoachSettings, saveCoachSettings } from "./coachSettings";
import { getAvatar } from "./avatarStore";
import { compressAvatarToDataUrl } from "./image";
import { pushSectionBestEffort } from "./syncData";

/**
 * Migrate a legacy IndexedDB avatar to the synced `avatarDataUrl` if (and only
 * if) one exists and hasn't already been migrated. Returns true when a migration
 * was performed, false otherwise. Never throws.
 *
 * @param csrfToken the session csrf token, used for the best-effort server push
 *   of the enriched profile (push is also gated by syncData's merge fuse).
 */
export async function migrateLegacyAvatar(
  csrfToken: string | null,
  isCancelled?: () => boolean,
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  let profile;
  try {
    profile = loadProfile();
  } catch {
    return false;
  }
  if (!profile) return false;
  // Already synced, or nothing legacy to migrate → no-op (idempotent).
  if (profile.avatarDataUrl) return false;
  if (!profile.avatarPhotoId) return false;

  let blob: Blob | null;
  try {
    blob = await getAvatar(profile.avatarPhotoId);
  } catch {
    return false;
  }
  if (!blob) return false; // blob already gone on this device — nothing to migrate.
  // STALE-SESSION GUARD: the getAvatar await yielded — if the user logged out /
  // switched accounts meanwhile, do NOT write a profile back into a cleared local.
  if (isCancelled?.()) return false;

  // Compress to the SAME bounded data: URL shape the profile form produces, so
  // the synced profile blob stays small (≤ ~180KB; see image.ts).
  let dataUrl: string | null;
  try {
    const file = blobToFile(blob);
    dataUrl = await compressAvatarToDataUrl(file);
  } catch {
    return false;
  }
  if (!dataUrl) return false; // undecodable / over budget → keep legacy as-is.
  // STALE-SESSION GUARD: compression also awaited — re-check before the write.
  if (isCancelled?.()) return false;

  // Persist: embed the data URL, drop the now-migrated legacy ref. saveProfile
  // stamps the synced section + fires its own best-effort push; we additionally
  // push here to be explicit about the cross-device sync intent.
  const migrated = {
    ...profile,
    avatarDataUrl: dataUrl,
    avatarPhotoId: undefined,
    updatedAt: new Date().toISOString(),
  };
  try {
    saveProfile(migrated);
  } catch {
    return false;
  }
  // Belt-and-braces push (saveProfile already pushes; this is harmless + clear).
  if (csrfToken) {
    try {
      pushSectionBestEffort("profile");
    } catch {
      /* non-fatal: local already holds the migrated avatar */
    }
  }
  return true;
}

/**
 * Migrate a legacy IndexedDB COACH avatar to the synced `avatarDataUrl` on the
 * coach settings, exactly mirroring migrateLegacyAvatar but for coachSettings.
 * Runs only when settings have a legacy `avatarPhotoId` and NO synced data URL.
 * Returns true when a migration was performed, false otherwise. Never throws.
 *
 * @param csrfToken the session csrf token, used for the best-effort server push
 *   of the enriched coach settings (push is also gated by syncData's merge fuse).
 */
export async function migrateLegacyCoachAvatar(
  csrfToken: string | null,
  isCancelled?: () => boolean,
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  let settings;
  try {
    settings = loadCoachSettings();
  } catch {
    return false;
  }
  if (!settings) return false;
  // Already synced, or nothing legacy to migrate → no-op (idempotent).
  if (settings.avatarDataUrl) return false;
  if (!settings.avatarPhotoId) return false;

  let blob: Blob | null;
  try {
    blob = await getAvatar(settings.avatarPhotoId);
  } catch {
    return false;
  }
  if (!blob) return false; // blob already gone on this device — nothing to migrate.
  if (isCancelled?.()) return false;

  let dataUrl: string | null;
  try {
    dataUrl = await compressAvatarToDataUrl(blobToFile(blob));
  } catch {
    return false;
  }
  if (!dataUrl) return false; // undecodable / over budget → keep legacy as-is.
  if (isCancelled?.()) return false;

  // Persist: embed the data URL, drop the now-migrated legacy ref. saveCoachSettings
  // sanitises on the way in (the data URL passes the prefix + size gate).
  const migrated = {
    ...settings,
    avatarDataUrl: dataUrl,
    avatarPhotoId: undefined,
  };
  try {
    saveCoachSettings(migrated);
  } catch {
    return false;
  }
  if (csrfToken) {
    try {
      pushSectionBestEffort("coachSettings");
    } catch {
      /* non-fatal: local already holds the migrated avatar */
    }
  }
  return true;
}

/** Wrap a Blob as a File so compressAvatarToDataUrl (which takes a File) can run.
 *  The name/type are cosmetic — the compressor only needs the bytes + a decodable
 *  image type. Falls back to a plain File when the blob has no type. */
function blobToFile(blob: Blob): File {
  const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
  return new File([blob], "legacy-avatar", { type });
}

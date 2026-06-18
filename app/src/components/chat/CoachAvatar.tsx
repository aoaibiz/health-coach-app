"use client";

import { useEffect, useState } from "react";
import { getAvatar } from "@/lib/avatarStore";
import {
  coachDisplayName,
  DEFAULT_COACH_AVATAR_SRC,
  presetAvatarSrc,
  type CoachSettings,
} from "@/lib/coachSettings";

/**
 * The coach's chat avatar. Resolves the configured face in priority order:
 *   1. a custom uploaded photo (blob in IndexedDB, same store as profile/meal
 *      photos — reuses avatarStore), then
 *   2. a chosen built-in preset asset, then
 *   3. the default 健康マン mascot.
 * Falls back to the mascot while a custom blob is loading or missing. The alt
 * text uses the chosen coach name so it reads as the user's chosen person.
 */
export function CoachAvatar({
  settings,
  className = "h-8 w-8",
}: {
  settings: CoachSettings | null | undefined;
  className?: string;
}) {
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  const photoId = settings?.avatarPhotoId;

  useEffect(() => {
    if (!photoId) {
      setCustomUrl(null);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    getAvatar(photoId)
      .then((blob) => {
        if (revoked || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setCustomUrl(objectUrl);
      })
      .catch(() => {
        /* fall back to the preset / mascot */
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoId]);

  const name = coachDisplayName(settings);
  const src = customUrl ?? presetAvatarSrc(settings?.presetAvatar) ?? DEFAULT_COACH_AVATAR_SRC;

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt={name}
      className={`${className} shrink-0 rounded-full bg-white object-cover ring-1 ring-slate-200 dark:ring-navy-700`}
    />
  );
}

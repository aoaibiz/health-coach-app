"use client";

import { useEffect, useState } from "react";
import { resolveAvatarUrl } from "@/lib/avatarStore";
import {
  coachDisplayName,
  DEFAULT_COACH_AVATAR_SRC,
  presetAvatarSrc,
  type CoachSettings,
} from "@/lib/coachSettings";

/**
 * The coach's chat avatar. Resolves the configured face in priority order:
 *   1. a custom uploaded photo — preferring the SYNCED data: URL
 *      (avatarDataUrl, follows the user across devices) and falling back to the
 *      legacy device-local IndexedDB blob (avatarPhotoId), via resolveAvatarUrl
 *      (the SAME resolver the profile avatar uses), then
 *   2. a chosen built-in preset asset, then
 *   3. the default 健康マン mascot.
 * Falls back to the preset/mascot while a custom blob is loading or missing. The
 * alt text uses the chosen coach name so it reads as the user's chosen person.
 */
export function CoachAvatar({
  settings,
  className = "h-8 w-8",
}: {
  settings: CoachSettings | null | undefined;
  className?: string;
}) {
  const [customUrl, setCustomUrl] = useState<string | null>(null);
  const avatarDataUrl = settings?.avatarDataUrl;
  const photoId = settings?.avatarPhotoId;

  useEffect(() => {
    if (!avatarDataUrl && !photoId) {
      setCustomUrl(null);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    resolveAvatarUrl({ avatarDataUrl, avatarPhotoId: photoId })
      .then((res) => {
        if (!res) {
          if (!revoked) setCustomUrl(null);
          return;
        }
        if (res.revoke) {
          // If cleanup already ran (revoked), revoke right here — the cleanup saw
          // objectUrl===null and couldn't, so a late resolve would leak.
          if (revoked) {
            URL.revokeObjectURL(res.url);
            return;
          }
          objectUrl = res.url; // cleanup will revoke it.
        }
        if (revoked) return;
        setCustomUrl(res.url);
      })
      .catch(() => {
        /* fall back to the preset / mascot */
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarDataUrl, photoId]);

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

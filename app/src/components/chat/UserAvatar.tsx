"use client";

import { useEffect, useState } from "react";
import { resolveAvatarUrl } from "@/lib/avatarStore";
import { avatarInitial } from "@/lib/profileView";
import type { Profile } from "@/lib/types";

/**
 * The user's chat avatar: prefers the SYNCED data URL embedded on the profile
 * (so it follows the user across devices), falling back to the legacy
 * device-local IndexedDB blob, then to the display-name initial on a neutral
 * circle when there's no photo (or while loading).
 */
export function UserAvatar({
  profile,
  className = "h-8 w-8",
}: {
  profile: Profile | null;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const avatarDataUrl = profile?.avatarDataUrl;
  const photoId = profile?.avatarPhotoId;

  useEffect(() => {
    if (!avatarDataUrl && !photoId) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    resolveAvatarUrl({ avatarDataUrl, avatarPhotoId: photoId })
      .then((res) => {
        if (!res) return;
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
        setUrl(res.url);
      })
      .catch(() => {
        /* fall back to the initial */
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarDataUrl, photoId]);

  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={url}
        alt="あなた"
        className={`${className} shrink-0 rounded-full object-cover`}
      />
    );
  }

  const initial = profile ? avatarInitial(profile) : "あ";
  return (
    <span
      className={`${className} flex shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent dark:bg-accent-light/15 dark:text-accent-light`}
      aria-hidden
    >
      {initial}
    </span>
  );
}

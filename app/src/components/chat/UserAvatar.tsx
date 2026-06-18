"use client";

import { useEffect, useState } from "react";
import { getAvatar } from "@/lib/avatarStore";
import { avatarInitial } from "@/lib/profileView";
import type { Profile } from "@/lib/types";

/**
 * The user's chat avatar: loads the profile photo blob from IndexedDB (same
 * store as meal/profile photos) and renders it; falls back to the display-name
 * initial on a neutral circle when there's no photo (or while loading).
 */
export function UserAvatar({
  profile,
  className = "h-8 w-8",
}: {
  profile: Profile | null;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const photoId = profile?.avatarPhotoId;

  useEffect(() => {
    if (!photoId) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    getAvatar(photoId)
      .then((blob) => {
        if (revoked || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        /* fall back to the initial */
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoId]);

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

"use client";

import { useEffect, useState } from "react";
import { getPhoto } from "@/lib/photoStore";

interface Props {
  photoId: string;
  alt?: string;
  className?: string;
}

/** Loads a photo blob from IndexedDB and renders it, managing the object URL. */
export function PhotoImage({ photoId, alt = "", className }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;

    getPhoto(photoId)
      .then((blob) => {
        if (revoked || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        /* ignore — show placeholder */
      });

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoId]);

  if (!url) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-100 text-slate-300 dark:bg-navy-800 dark:text-navy-600 ${className ?? ""}`}
      >
        <span className="text-xs">…</span>
      </div>
    );
  }

  // Plain <img>: next/image's optimizer is disabled in static export anyway.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className={className} />;
}

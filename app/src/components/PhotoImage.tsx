"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getPhoto } from "@/lib/photoStore";

interface Props {
  photoId: string;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
  onBlobLoaded?: (blob: Blob) => void;
}

/** Loads a photo blob from IndexedDB and renders it, managing the object URL. */
export function PhotoImage({ photoId, alt = "", className, fallback, onBlobLoaded }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;

    getPhoto(photoId)
      .then((blob) => {
        if (revoked || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        onBlobLoaded?.(blob);
      })
      .catch(() => {
        /* ignore — show placeholder */
      });

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [onBlobLoaded, photoId]);

  if (!url) {
    if (fallback) return <>{fallback}</>;

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

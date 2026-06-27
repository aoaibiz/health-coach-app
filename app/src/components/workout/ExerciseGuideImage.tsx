"use client";

import { useEffect, useState } from "react";
import type { ExerciseGuide } from "@/lib/exerciseGuide";

interface Props {
  guide: ExerciseGuide;
  className?: string;
}

/**
 * The figure-guide thumbnail for an exercise (AIプランナー Phase3). Renders the
 * matched illustration for a move (e.g. スクワット → /exercise-guides/squat.png).
 *
 * GRACEFUL FALLBACK: if the PNG is missing or fails to load (onError) we render
 * NOTHING — the surrounding card already works without a figure, so a broken
 * image never appears. `guide.slug` is keyed so switching exercises re-arms the
 * error state (a previously-failed slug doesn't suppress a good one).
 *
 * Plain <img>: the static export disables next/image's optimizer anyway (same as
 * PhotoImage / CoachAvatar), so there's nothing to gain from next/image here.
 */
export function ExerciseGuideImage({ guide, className = "" }: Props) {
  const [failed, setFailed] = useState(false);

  // Re-arm when the matched figure changes (editing renames the exercise).
  useEffect(() => {
    setFailed(false);
  }, [guide.slug]);

  if (failed) return null;

  return (
    <img
      key={guide.slug}
      src={guide.src}
      alt={`${guide.label}のやり方の図解`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-xl bg-transparent object-contain ring-0 ${className}`}
    />
  );
}

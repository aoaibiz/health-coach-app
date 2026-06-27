"use client";

import { useEffect, useState } from "react";
import type { DishGuide } from "@/lib/dishGuide";

interface Props {
  guide: DishGuide;
  className?: string;
}

/**
 * The appetising dish-image thumbnail for a meal (AIプランナー 第3陣D2 — the
 * meal-side twin of ExerciseGuideImage). Renders the matched illustration for a
 * dish (e.g. 親子丼 → /dish-guides/oyakodon.png).
 *
 * IMAGE FIGURE ONLY: this is an「イメージ図」for display — it never reflects or
 * changes any recorded nutrition.
 *
 * GRACEFUL FALLBACK: if the PNG is missing or fails to load (onError) we render
 * NOTHING — the surrounding card already works without an image, so a broken
 * image never appears. `guide.slug` is keyed so switching dishes re-arms the
 * error state (a previously-failed slug doesn't suppress a good one).
 *
 * Plain <img>: the static export disables next/image's optimizer anyway (same as
 * PhotoImage / ExerciseGuideImage), so there's nothing to gain from next/image.
 */
export function DishGuideImage({ guide, className = "" }: Props) {
  const [failed, setFailed] = useState(false);

  // Re-arm when the matched dish changes (editing renames the meal/items).
  useEffect(() => {
    setFailed(false);
  }, [guide.slug]);

  if (failed) return null;

  return (
    <img
      key={guide.slug}
      src={guide.src}
      alt={`${guide.label}のイメージ画像`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-xl bg-transparent object-cover ring-0 ${className}`}
    />
  );
}

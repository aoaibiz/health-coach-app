"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadProfile, saveProfile } from "@/lib/storage";
import { calcTargets } from "@/lib/nutrition";
import type { NutritionTargets, Profile } from "@/lib/types";

/**
 * Loads/persists the owner's profile and derives daily targets from it.
 * `targets` is always recomputed (never stored) so it can't drift from the
 * profile or hold a fabricated number.
 */
export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setProfile(loadProfile());
    setReady(true);
  }, []);

  const save = useCallback((next: Profile) => {
    saveProfile(next);
    setProfile(next);
  }, []);

  const targets: NutritionTargets | null = useMemo(
    () => (profile ? calcTargets(profile) : null),
    [profile],
  );

  return { profile, targets, ready, save };
}

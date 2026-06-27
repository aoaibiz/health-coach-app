"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadProfile, saveProfile } from "@/lib/storage";
import { DATA_CHANGED_EVENT } from "@/lib/syncData";
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
    const refresh = () => setProfile(loadProfile());
    refresh();
    setReady(true);
    // Re-read when another tab writes (`storage`), the tab regains focus, or the
    // cross-device live-pull / login-merge writes in THIS tab (DATA_CHANGED_EVENT,
    // which the same-document `storage` event does not cover). Lets a profile /
    // avatar set on another device appear here without a reload.
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(DATA_CHANGED_EVENT, refresh);
    };
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

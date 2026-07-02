"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadCoachSettings,
  saveCoachSettings,
  type CoachSettings,
} from "@/lib/coachSettings";

/**
 * Loads/persists the user-customisable coach persona (name / avatar /
 * personality), mirroring useProfile. localStorage-backed (no provider), so it
 * stays decoupled from the date-sync layout work happening elsewhere.
 */
export function useCoachSettings() {
  const [settings, setSettings] = useState<CoachSettings>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSettings(loadCoachSettings());
    setReady(true);
  }, []);

  // Returns whether the save PERSISTED. A localStorage failure propagates from
  // saveCoachSettings; we catch it and return false so the form stays in edit mode
  // and shows a real error instead of a phantom "設定済み" view (Codex audit C3).
  const save = useCallback((next: CoachSettings): boolean => {
    try {
      saveCoachSettings(next);
      // Re-read so the in-memory copy matches exactly what was persisted (sanitised).
      setSettings(loadCoachSettings());
      return true;
    } catch {
      return false; // not persisted — caller must not transition to the saved view.
    }
  }, []);

  return { settings, ready, save };
}

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

  const save = useCallback((next: CoachSettings) => {
    saveCoachSettings(next);
    // Re-read so the in-memory copy matches exactly what was persisted (sanitised).
    setSettings(loadCoachSettings());
  }, []);

  return { settings, ready, save };
}

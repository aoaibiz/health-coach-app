"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { toDateKey } from "@/lib/date";
import {
  SELECTED_DATE_KEY,
  isValidDateKey,
  loadSelectedDate,
  saveSelectedDate,
} from "@/lib/selectedDate";

interface SelectedDateValue {
  /** The shared selected day as a YYYY-MM-DD key (same key used everywhere). */
  date: string;
  /** Set the shared selected day; persists + broadcasts to other tabs. */
  setDate: (next: string) => void;
}

const SelectedDateContext = createContext<SelectedDateValue | null>(null);

/**
 * Holds the ONE selected date shared by every page. Mounted at the layout level
 * (AppShell) so the App-Router route change between pages does NOT remount it —
 * that is what makes the selection stick across navigation. Persisted to
 * localStorage so it also survives a reload, and synced across tabs via the
 * `storage` event.
 *
 * First render uses today so the server-rendered / statically-exported HTML is
 * deterministic (no window/localStorage at render time); the persisted value is
 * adopted in an effect after hydration.
 */
export function SelectedDateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [date, setDateState] = useState(() => toDateKey());

  // Adopt the persisted value after mount (client only — keeps SSR/export safe).
  useEffect(() => {
    setDateState(loadSelectedDate());
  }, []);

  // Keep tabs in sync: another tab changing the date updates this one.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== SELECTED_DATE_KEY) return;
      setDateState(isValidDateKey(e.newValue) ? e.newValue : toDateKey());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setDate = useCallback((next: string) => {
    setDateState(next);
    saveSelectedDate(next);
  }, []);

  return (
    <SelectedDateContext.Provider value={{ date, setDate }}>
      {children}
    </SelectedDateContext.Provider>
  );
}

/** Read + set the globally-shared selected date. */
export function useSelectedDate(): SelectedDateValue {
  const ctx = useContext(SelectedDateContext);
  if (!ctx) {
    throw new Error("useSelectedDate must be used within SelectedDateProvider");
  }
  return ctx;
}

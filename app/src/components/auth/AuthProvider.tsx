"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  initialAuthState,
  reduceLoggedIn,
  reduceLoggedOut,
  reduceSessionChecked,
  type AuthState,
} from "@/lib/authState";
import * as authApi from "@/lib/authApi";
import { isPushSupported, registerServiceWorker } from "@/lib/push";

interface AuthContextValue {
  state: AuthState;
  /** POST /auth/login → on success enters authed + stores csrfToken in memory. */
  login: (email: string, password: string) => Promise<void>;
  /** POST /auth/register → 202 (no auto-login). Throws on failure for the UI. */
  register: (email: string, password: string) => Promise<authApi.RegisterResult>;
  /** POST /auth/logout (with CSRF) → clears state → back to login. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Starts in "checking" → render a neutral splash until /auth/me resolves.
  const [state, setState] = useState<AuthState>(initialAuthState);

  // Session gate: on app load, ask the backend who we are (cookie-based).
  // 200 → authed shell; 401 (or any failure) → login shell. Never hangs.
  useEffect(() => {
    let cancelled = false;
    authApi
      .fetchMe()
      .then((me) => {
        // 200 → authed + carry the session's csrfToken so a reloaded session can
        // still authorize logout; null (401) → unauthed shell.
        if (!cancelled) {
          setState(
            me
              ? reduceSessionChecked(me.user, me.csrfToken)
              : reduceSessionChecked(null),
          );
        }
      })
      .catch(() => {
        // Network / unexpected error: default to the login shell, don't hang
        // on the splash. (DMD: the app is always reachable to log in.)
        if (!cancelled) setState(reduceSessionChecked(null));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once the session is known to be authed, register the push service worker
  // ONCE. This is silent and safe: registration alone never prompts for the
  // notification permission (that only happens when the user taps the 通知 button
  // on /profile). We do it here — the single place that already knows auth — so
  // the SW is warm by the time the user opens 設定, and no page/component needs a
  // bespoke registration effect. Guarded by isPushSupported() (SSG/iOS-safe).
  useEffect(() => {
    if (state.status !== "authed") return;
    if (!isPushSupported()) return;
    void registerServiceWorker();
  }, [state.status]);

  const login = useCallback(async (email: string, password: string) => {
    const { user, csrfToken } = await authApi.login(email, password);
    setState(reduceLoggedIn(user, csrfToken));
  }, []);

  const register = useCallback(
    (email: string, password: string) => authApi.register(email, password),
    [],
  );

  // Keep a ref so `logout` always reads the latest csrfToken without re-creating
  // the callback (and without making csrfToken a dependency that the UI sees).
  const stateRef = useLatestRef(state);

  const logout = useCallback(async () => {
    // Capture the current csrf token for the X-CSRF-Token header, then clear
    // local state regardless of the network result so the user lands on login.
    try {
      await authApi.logout(stateRef.current.csrfToken);
    } finally {
      setState(reduceLoggedOut());
    }
    // stateRef is a stable ref object → not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthContext.Provider value={{ state, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

// Small helper: a ref that always holds the latest value (avoids stale closures
// in the logout callback while keeping it stable).
function useLatestRef<T>(value: T) {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}

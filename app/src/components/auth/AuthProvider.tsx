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
import {
  clearAllLocalData,
  clearLastUserId,
  getLastUserId,
  hasAnyUserData,
  setLastUserId,
  userIdentityKey,
} from "@/lib/userScope";

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

  // ── USER-BOUNDARY DATA ISOLATION (privacy) ────────────────────────────────
  // All user data lives in per-DEVICE localStorage (+ IndexedDB photos) under
  // fixed, un-namespaced keys. When a DIFFERENT user becomes authed on this
  // browser (login, or a session-check resolving to someone new), the previous
  // user's local data MUST be wiped — otherwise the new user would see the prior
  // user's profile/meals/chat/photos (the cross-account leak). The SAME user, or
  // the first-ever login on this browser, keeps local intact (it's their data).
  //
  // This app has NO server-side data sync, so the wipe is unconditional for a
  // switched/unknown user — there is no merge to sequence against.
  useEffect(() => {
    if (state.status !== "authed") return;

    const identity = userIdentityKey(state.user);
    const previous = getLastUserId();
    const isDifferentUser = !!identity && !!previous && identity !== previous;
    // FAIL CLOSED on an UNKNOWN identity: if we can't derive who this is (no
    // id/email) we cannot prove leftover local data belongs to this session's
    // user, so we wipe rather than expose it whenever ANY user data is present.
    // `hasAnyUserData()` (not just a recorded previous user) also covers the
    // pre-fix-upgrade path: data already on disk before lastUserId was ever set.
    const unknownIdentityWithData = !identity && (!!previous || hasAnyUserData());
    const mustClear = isDifferentUser || unknownIdentityWithData;

    let cancelled = false;
    void (async () => {
      if (mustClear) {
        await clearAllLocalData().catch(() => undefined);
      }
      if (cancelled) return;
      // Bind this browser to the current user so the NEXT login can detect a
      // switch. When identity is unknown, forget the binding so the next login
      // also fails closed rather than matching a stale id.
      if (identity) setLastUserId(identity);
      else clearLastUserId();
    })();

    return () => {
      cancelled = true;
    };
  }, [state.status, state.user]);

  const login = useCallback(async (email: string, password: string) => {
    const { user, csrfToken } = await authApi.login(email, password);
    // PRIVACY: reconcile the user boundary BEFORE committing authed state, so the
    // app shell never mounts over a DIFFERENT user's leftover local data even for
    // a moment (e.g. user A still authed in this SPA → user B logs in without a
    // prior logout). Mirrors the passive effect's decision, but runs synchronously
    // ahead of setState to close the brief render window. The passive effect below
    // still backstops the /auth/me (reload) path. Same user / clean device → no
    // wipe (the user keeps their own data).
    const identity = userIdentityKey(user);
    const previous = getLastUserId();
    const isDifferentUser = !!identity && !!previous && identity !== previous;
    const unknownIdentityWithData = !identity && (!!previous || hasAnyUserData());
    if (isDifferentUser || unknownIdentityWithData) {
      await clearAllLocalData().catch(() => undefined);
    }
    if (identity) setLastUserId(identity);
    else clearLastUserId();
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
    // A network-layer failure (offline/DNS) rejects authApi.logout(); swallow it
    // so `void logout()` callers never see an unhandled rejection — the contract
    // is "always lands on login", and the local wipe below runs regardless.
    try {
      await authApi.logout(stateRef.current.csrfToken);
    } catch {
      /* network logout failed — still clear local state below */
    } finally {
      // PRIVACY: WIPE this user's local data (localStorage sections + IndexedDB
      // photos) and forget the browser-bound user. On a shared device the next
      // person must NOT see the prior user's profile/meals/chat/photos. The auth
      // API logout already revoked the session server-side; this clears the local
      // footprint to match.
      await clearAllLocalData().catch(() => undefined);
      clearLastUserId();
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

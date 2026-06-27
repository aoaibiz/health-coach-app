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
  mergeOnLogin,
  refreshFromServer,
  setSyncCsrfToken,
  syncEnabled,
  pushSectionBestEffort,
} from "@/lib/syncData";
import { migrateLegacyAvatar, migrateLegacyCoachAvatar } from "@/lib/avatarMigration";
import {
  clearAllLocalData,
  clearLastUserId,
  getLastUserId,
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

  // ── Durable data sync (Stage 2) ───────────────────────────────────────────
  // Once authed (with the session's csrfToken), back up + merge the user's data
  // across devices. The merge is a UNION (see syncData.ts): it can only ADD to
  // local — a missing/empty/failed server response NEVER deletes local data.
  //
  // Sections whose save path lives in storage.ts (meals/workouts/profile) push
  // themselves on every write. The other three (weightLog/coachSettings/chat)
  // are written by modules we don't own, so we flush THEM here whenever the tab
  // is hidden/closed and on a slow interval — local stays the source of truth;
  // these flushes are best-effort backups that never throw.
  useEffect(() => {
    if (state.status !== "authed" || !state.csrfToken) {
      setSyncCsrfToken(null); // logged out / no csrf → disable background pushes.
      return;
    }

    let cancelled = false;

    // CLOSE THE OLD SYNC GATE SYNCHRONOUSLY, before any async work. On an
    // authed→authed account switch in the same mounted SPA the previous user's
    // csrf + merged-section flags are still live; clearing them here (it also
    // resets mergedSections) means a background flush/retry that fires during
    // the async clear/merge below can NOT push the previous user's local data
    // until THIS user's merge re-opens the gate per section. Defense-in-depth
    // alongside attemptPush's own gate re-check.
    setSyncCsrfToken(null);

    // ── USER-BOUNDARY DATA ISOLATION (privacy) ──────────────────────────────
    // Before enabling sync / merging, decide whether THIS authed user is the
    // SAME one this browser last held. If a DIFFERENT user just logged in, the
    // previous user's local data MUST be wiped first — otherwise mergeOnLogin's
    // UNION would surface the prior user's meals/profile/chat to the new user
    // (the cross-account leak). Same user, or the first-ever login on this
    // browser, keeps local intact (the union protects the user's own data).
    const identity = userIdentityKey(state.user);
    const previous = getLastUserId();
    const isDifferentUser = !!identity && !!previous && identity !== previous;
    // FAIL CLOSED on an UNKNOWN identity: if we can't derive who this is (no
    // id/email), we cannot prove it's the same user who owns the local data, so
    // we must NOT let the union surface it. Wipe local when there is ANY recorded
    // previous user we can't confirm a match against. (The merge then pulls this
    // session's server data fresh; on the live API identity is always present, so
    // this only bites a malformed/abnormal auth response — privacy wins there.)
    const unknownIdentityWithPrior = !identity && !!previous;
    const mustClear = isDifferentUser || unknownIdentityWithPrior;

    // Run the (possibly async) clear, THEN enable sync + merge. Sequencing the
    // clear before setSyncCsrfToken/mergeOnLogin guarantees the merge reads an
    // empty local for a switched/unknown user (no leftover to union in).
    void (async () => {
      if (mustClear) {
        await clearAllLocalData(); // wipe prior user's localStorage + IndexedDB photos.
      }
      if (cancelled) return;
      // Bind this browser to the current user (records identity for next login).
      // Done even on same-user / first-login so the next switch is detectable.
      // When identity is unknown we forget the binding so the NEXT login also
      // fails closed rather than matching against a stale id.
      if (identity) setLastUserId(identity);
      else clearLastUserId();

      setSyncCsrfToken(state.csrfToken);
      // One-time login merge: fetch server → (union for same user / fresh pull
      // after a wipe for a switched user) → write BOTH local + server.
      // isCancelled lets the merge ABORT mid-flight if the user logs out / switches
      // accounts while a per-section server fetch is in progress — so a slow
      // previous-user merge can't repopulate the just-cleared local (cross-account
      // leak). `cancelled` flips true in this effect's cleanup, which runs on any
      // status/user/csrf change (logout or A→B switch).
      await mergeOnLogin({
        csrfToken: state.csrfToken,
        isCancelled: () => cancelled,
        // Synchronous gate: logout flips setSyncCsrfToken(null) BEFORE this
        // effect's cleanup flips `cancelled`, so this stops an in-flight login
        // merge from writing the logged-out user's data back into the cleared
        // local during the logout window (Codex review). On an A→B switch the
        // gate re-opens for B, so `cancelled` (above) covers that case.
        isGateClosed: () => !syncEnabled(),
      }).catch(() => {
        // mergeOnLogin isolates per-section errors; this is belt-and-braces.
      });
      if (cancelled) return;
      // After the profile is restored, migrate a legacy device-local IndexedDB
      // avatar into the synced profile blob so it shows on other devices too.
      // Same stale-session guard so a logout/switch mid-migration can't write a
      // previous user's profile back into the cleared local.
      await migrateLegacyAvatar(state.csrfToken, () => cancelled).catch(() => {
        // Best-effort: a failed migration just leaves the avatar device-local.
      });
      if (cancelled) return;
      // Same migration for a legacy device-local COACH avatar → synced
      // coachSettings.avatarDataUrl, so a custom coach photo also crosses devices.
      await migrateLegacyCoachAvatar(state.csrfToken, () => cancelled).catch(() => {
        // Best-effort: a failed migration just leaves the coach avatar device-local.
      });
    })();

    // Catch-all backup for the sections not covered by storage.ts's per-save push.
    const flush = () => {
      if (cancelled) return;
      pushSectionBestEffort("weightLog");
      pushSectionBestEffort("coachSettings");
      pushSectionBestEffort("chat");
      // The access key is written by the settings form (also not covered by
      // storage.ts's per-save push), so back it up here too.
      pushSectionBestEffort("apiToken");
      // Delete tombstones (incl. any `cleared` revive op) — back them up here too
      // so a delete/re-add isn't left only on this device if a per-save push was
      // missed (e.g. tab closed before the deletions push landed).
      pushSectionBestEffort("deletions");
    };
    const onVisibilityHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibilityHidden);
    window.addEventListener("pagehide", flush);
    // Slow safety-net interval (2 min) so a long single-session of chat/weight
    // edits is backed up even without a tab-hide. Cheap: 3 small PUTs, deduped
    // by always reading the freshest local value.
    const flushInterval = window.setInterval(flush, 120_000);

    // ── LIVE CROSS-DEVICE PULL ────────────────────────────────────────────────
    // Writes already push UP on save, but an already-open tab never re-PULLED, so
    // a meal/profile photo added on ANOTHER device only appeared after a reload or
    // re-login. Pull the server's latest when the tab regains focus / becomes
    // visible (the moment the user returns to it) and on a slow interval, so the
    // open device picks up the other device's changes. refreshFromServer is the
    // same UNION as the login merge — it can only ADD to local, never drop a local
    // edit, and the shrink/stale-session guards still apply. Throttled so a burst
    // of focus/visibility events can't hammer the API.
    let lastPullAt = 0;
    let pulling = false;
    const MIN_PULL_GAP_MS = 10_000;
    const pull = (force = false) => {
      if (cancelled || pulling) return;
      const now = Date.now();
      if (!force && now - lastPullAt < MIN_PULL_GAP_MS) return;
      lastPullAt = now;
      pulling = true;
      void refreshFromServer({
        csrfToken: state.csrfToken,
        isCancelled: () => cancelled,
      })
        .catch(() => {
          // refreshFromServer isolates per-section errors; belt-and-braces.
        })
        .finally(() => {
          pulling = false;
        });
    };
    const onFocus = () => pull();
    const onVisiblePull = () => {
      if (document.visibilityState === "visible") pull();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisiblePull);
    // Slow interval so a tab left open in the foreground still converges with edits
    // made elsewhere (e.g. the family's phone) without any user interaction.
    const pullInterval = window.setInterval(() => pull(true), 60_000);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityHidden);
      window.removeEventListener("pagehide", flush);
      window.clearInterval(flushInterval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisiblePull);
      window.clearInterval(pullInterval);
    };
  }, [state.status, state.csrfToken, state.user]);

  const login = useCallback(async (email: string, password: string) => {
    // PRIVACY (defense-in-depth): synchronously close any still-open sync gate
    // BEFORE the login request, so on an A→B account switch no in-flight sync
    // work for A can push/pull during the B login round-trip. The authed effect
    // re-opens the gate (and clears local for a different user) once B commits.
    setSyncCsrfToken(null);
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
      // PRIVACY: disable background pushes, then WIPE this user's local data
      // (localStorage sections + IndexedDB photos) and forget the browser-bound
      // user. On a shared device the next person must NOT see the prior user's
      // meals/profile/chat/photos. The auth-API logout already revoked the
      // session server-side; this clears the local footprint to match.
      setSyncCsrfToken(null);
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

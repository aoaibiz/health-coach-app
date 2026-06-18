// Pure auth state machine for the Stage-1 session gate.
//
// This module is intentionally side-effect free (no fetch, no window) so the
// gating logic — "did /auth/me succeed? → show the app, else show login" plus
// csrf-token storage and the register→login flow — is unit-testable in the
// node test environment. The React layer (AuthProvider) drives I/O and feeds
// the results through these transitions.

/** The user object the backend returns from /auth/login and /auth/me. */
export interface AuthUser {
  id?: string;
  email: string;
  // The backend may include more fields; we keep it open but typed-lite.
  [key: string]: unknown;
}

/**
 * App-level auth status:
 *  - "checking"  : initial — /auth/me in flight, render a neutral splash.
 *  - "unauthed"  : no valid session → show login / register.
 *  - "authed"    : valid session → show the app (chat-home).
 */
export type AuthStatus = "checking" | "unauthed" | "authed";

export interface AuthState {
  status: AuthStatus;
  /** The signed-in user, only present when status === "authed". */
  user: AuthUser | null;
  /**
   * CSRF token from the login response, kept in memory (NOT persisted) and sent
   * as X-CSRF-Token on state-changing requests (logout, and later data PUT).
   */
  csrfToken: string | null;
}

/** Where the app starts before /auth/me resolves. */
export const initialAuthState: AuthState = {
  status: "checking",
  user: null,
  csrfToken: null,
};

// ---- Transitions (pure) ----------------------------------------------------

/**
 * Result of GET /auth/me on app load.
 * @param user the user when 200, or null when 401/unauthenticated.
 * @param csrfToken the session's CSRF token, re-surfaced by /auth/me so a
 *   reloaded-but-authed session can still send X-CSRF-Token on logout. Without
 *   this, a page reload would restore the authed state with a null token and
 *   logout would be silently rejected (session never revoked server-side) — a
 *   logout-bypass on shared devices.
 */
export function reduceSessionChecked(
  user: AuthUser | null,
  csrfToken?: string | null,
): AuthState {
  if (user) {
    return { status: "authed", user, csrfToken: csrfToken || null };
  }
  return { status: "unauthed", user: null, csrfToken: null };
}

/**
 * Result of a successful POST /auth/login. The login response carries both the
 * user fields and the csrfToken; we split them out and enter the authed state.
 */
export function reduceLoggedIn(user: AuthUser, csrfToken: string): AuthState {
  return { status: "authed", user, csrfToken: csrfToken || null };
}

/**
 * Result of logout (or any forced session end, e.g. a 401 from a later call).
 * Clears the user AND the in-memory csrf token, returns to the login shell.
 */
export function reduceLoggedOut(): AuthState {
  return { status: "unauthed", user: null, csrfToken: null };
}

// ---- Routing decision (pure) -----------------------------------------------

/** What the AuthGate should render for a given status. */
export type GateView = "splash" | "auth" | "app";

/** Map auth status → which shell the gate shows. */
export function gateView(status: AuthStatus): GateView {
  switch (status) {
    case "checking":
      return "splash";
    case "authed":
      return "app";
    case "unauthed":
    default:
      return "auth";
  }
}

/** True only when the app content (chat-home + sub-pages) should mount. */
export function isAuthed(state: AuthState): boolean {
  return state.status === "authed" && state.user != null;
}

// ---- Register → login flow (pure) ------------------------------------------

/** Which sub-screen the unauthenticated shell shows. */
export type AuthScreenMode = "login" | "register";

/**
 * After a successful register (202, no auto-login) we flip the unauth screen to
 * login and surface a "登録しました。ログインしてください" notice. This returns
 * the next screen mode; the notice text is the UI's concern.
 */
export function reduceRegistered(): AuthScreenMode {
  return "login";
}

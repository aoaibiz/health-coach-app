import { describe, it, expect } from "vitest";
import {
  initialAuthState,
  reduceSessionChecked,
  reduceLoggedIn,
  reduceLoggedOut,
  reduceRegistered,
  gateView,
  isAuthed,
  type AuthState,
  type AuthUser,
} from "./authState";

const user: AuthUser = { id: "u1", email: "a@example.com" };

describe("auth state machine — initial / session check", () => {
  it("starts in 'checking' with no user and no csrf token", () => {
    expect(initialAuthState).toEqual({
      status: "checking",
      user: null,
      csrfToken: null,
    });
  });

  it("session-check with a user → authed (the app shows)", () => {
    const s = reduceSessionChecked(user, "csrf-from-me");
    expect(s.status).toBe("authed");
    expect(s.user).toEqual(user);
    expect(isAuthed(s)).toBe(true);
  });

  it("session-check with null (401) → unauthed (login shows)", () => {
    const s = reduceSessionChecked(null);
    expect(s.status).toBe("unauthed");
    expect(s.user).toBeNull();
    expect(isAuthed(s)).toBe(false);
  });

  it("session-check CARRIES the csrf token from /auth/me (logout-after-reload fix)", () => {
    // Regression guard for the logout-bypass bug: after a reload the SPA restores
    // the authed state via /auth/me, which now re-surfaces the session csrfToken.
    // It MUST land in AuthState so the subsequent logout sends X-CSRF-Token and
    // the backend actually revokes the session.
    const s = reduceSessionChecked(user, "csrf-from-me");
    expect(s.csrfToken).toBe("csrf-from-me");
  });

  it("a reloaded-but-authed state has a non-null csrf → logout can include the header", () => {
    // Simulate the post-reload restore: /auth/me returned a user + token.
    const reloaded = reduceSessionChecked(user, "csrf-from-me");
    expect(isAuthed(reloaded)).toBe(true);
    // The token the logout call will read off state is the live session token
    // (non-null) — exactly what the backend's CSRF gate requires on logout.
    expect(reloaded.csrfToken).not.toBeNull();
    expect(reloaded.csrfToken).toBe("csrf-from-me");
  });

  it("session-check without a token (or empty) normalizes to null, not ''", () => {
    expect(reduceSessionChecked(user).csrfToken).toBeNull();
    expect(reduceSessionChecked(user, "").csrfToken).toBeNull();
    expect(reduceSessionChecked(user, null).csrfToken).toBeNull();
  });
});

describe("auth state machine — login stores csrf token", () => {
  it("login → authed AND stores the csrf token in state", () => {
    const s = reduceLoggedIn(user, "csrf-abc");
    expect(s.status).toBe("authed");
    expect(s.user).toEqual(user);
    expect(s.csrfToken).toBe("csrf-abc");
    expect(isAuthed(s)).toBe(true);
  });

  it("an empty csrf token is normalized to null (not stored as '')", () => {
    expect(reduceLoggedIn(user, "").csrfToken).toBeNull();
  });
});

describe("auth state machine — logout clears state", () => {
  it("logout from an authed+csrf state → unauthed, user AND csrf cleared", () => {
    const authed: AuthState = reduceLoggedIn(user, "csrf-abc");
    expect(authed.csrfToken).toBe("csrf-abc"); // precondition
    const out = reduceLoggedOut();
    expect(out.status).toBe("unauthed");
    expect(out.user).toBeNull();
    expect(out.csrfToken).toBeNull();
    expect(isAuthed(out)).toBe(false);
  });
});

describe("auth state machine — register → login flow", () => {
  it("after a successful register (202, no auto-login) the screen flips to login", () => {
    expect(reduceRegistered()).toBe("login");
  });

  it("a full flow: checking → register → login → authed → logout → unauthed", () => {
    // load
    let s: AuthState = initialAuthState;
    expect(gateView(s.status)).toBe("splash");
    // /auth/me returns 401 → unauthed shell
    s = reduceSessionChecked(null);
    expect(gateView(s.status)).toBe("auth");
    // user registers → still on the unauth shell, screen mode → login
    expect(reduceRegistered()).toBe("login");
    // user logs in → authed, csrf stored
    s = reduceLoggedIn(user, "csrf-xyz");
    expect(gateView(s.status)).toBe("app");
    expect(s.csrfToken).toBe("csrf-xyz");
    // user logs out → unauthed, csrf gone
    s = reduceLoggedOut();
    expect(gateView(s.status)).toBe("auth");
    expect(s.csrfToken).toBeNull();
  });
});

describe("gateView — routing decision per status", () => {
  it("checking → splash", () => expect(gateView("checking")).toBe("splash"));
  it("authed → app", () => expect(gateView("authed")).toBe("app"));
  it("unauthed → auth", () => expect(gateView("unauthed")).toBe("auth"));
});

describe("isAuthed guard", () => {
  it("is false unless status is authed AND a user is present", () => {
    expect(isAuthed({ status: "authed", user: null, csrfToken: null })).toBe(false);
    expect(isAuthed({ status: "checking", user, csrfToken: null })).toBe(false);
    expect(isAuthed({ status: "authed", user, csrfToken: "x" })).toBe(true);
  });
});

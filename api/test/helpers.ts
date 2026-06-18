// Shared test helpers. `getSetCookie()` exists on the Workers/undici Headers but
// isn't in the TS DOM lib, so we access it through a narrow typed cast in ONE
// place rather than scattering casts across the suites.

interface SetCookieCapable {
  getSetCookie?: () => string[];
  get(name: string): string | null;
}

/** All Set-Cookie header values from a Response. */
export function setCookies(res: Response): string[] {
  const h = res.headers as unknown as SetCookieCapable;
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = h.get("set-cookie");
  return single ? [single] : [];
}

/** Extract a named cookie's value from a Response's Set-Cookie headers. */
export function getCookie(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return decodeURIComponent(m[1]!);
  }
  return null;
}

const APP_ORIGIN = "http://localhost:3000";

interface AuthedSession {
  /** Combined Cookie header value ("ha_session=...; ha_csrf=...") for requests. */
  cookie: string;
  /** The session's CSRF token (to echo in the X-CSRF-Token header). */
  csrf: string;
  /** The authenticated user's id. */
  userId: string;
}

/**
 * Register (202, no session) THEN log in (200, session) — the post-hardening
 * flow now that /auth/register no longer auto-logs-in (anti-enumeration). Returns
 * the authenticated cookie + CSRF token tests use to call protected endpoints.
 * `self` is the test `SELF` (typed loosely to avoid importing cloudflare:test here).
 */
export async function registerAndLogin(
  self: { fetch: (req: Request) => Promise<Response> },
  email: string,
  password = "password123",
): Promise<AuthedSession> {
  const mk = (path: string, body: unknown) =>
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  await self.fetch(mk("/auth/register", { email, password }));
  const login = await self.fetch(mk("/auth/login", { email, password }));
  const session = getCookie(login, "ha_session");
  const csrf = getCookie(login, "ha_csrf");
  if (!session || !csrf) {
    throw new Error(`registerAndLogin: login did not return a session (status ${login.status})`);
  }
  const userId = ((await login.json()) as { user: { id: string } }).user.id;
  return { cookie: `ha_session=${session}; ha_csrf=${csrf}`, csrf, userId };
}

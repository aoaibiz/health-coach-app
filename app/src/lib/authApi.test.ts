import { describe, it, expect, vi } from "vitest";
import {
  HEALTH_API_BASE,
  register,
  login,
  fetchMe,
  logout,
  googleStartUrl,
  calendarToday,
  AuthApiError,
} from "./authApi";

/** Build a fake fetch that records its call and returns a canned Response-like. */
function fakeFetch(
  status: number,
  body: unknown,
  capture?: { url?: string; init?: RequestInit },
): typeof fetch {
  return ((url: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    const res = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new Error("no body");
        return body;
      },
    } as unknown as Response;
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
}

describe("authApi — base URL config", () => {
  it("targets the cross-subdomain API and is the single source of truth", () => {
    expect(HEALTH_API_BASE).toBe("https://health-api.mogubusi.trade");
    expect(googleStartUrl()).toBe(
      "https://health-api.mogubusi.trade/auth/google/start",
    );
  });
});

describe("authApi — cross-subdomain credentials", () => {
  it("register sends credentials:include + JSON body to /auth/register", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const res = await register("a@b.com", "pw", {
      fetchImpl: fakeFetch(202, { ok: true, message: "登録しました。" }, cap),
    });
    expect(res.ok).toBe(true);
    expect(cap.url).toBe("https://health-api.mogubusi.trade/auth/register");
    expect(cap.init?.method).toBe("POST");
    expect(cap.init?.credentials).toBe("include");
    expect(JSON.parse(String(cap.init?.body))).toEqual({
      email: "a@b.com",
      password: "pw",
    });
  });

  it("login sends credentials:include and splits user from csrfToken", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const result = await login("a@b.com", "pw", {
      fetchImpl: fakeFetch(
        200,
        { user: { id: "u1", email: "a@b.com" }, csrfToken: "csrf-123" },
        cap,
      ),
    });
    expect(cap.init?.credentials).toBe("include");
    expect(result.csrfToken).toBe("csrf-123");
    expect(result.user).toEqual({ id: "u1", email: "a@b.com" });
    expect((result.user as Record<string, unknown>).csrfToken).toBeUndefined();
  });

  it("login still accepts the legacy flat user shape", async () => {
    const result = await login("a@b.com", "pw", {
      fetchImpl: fakeFetch(
        200,
        { id: "u1", email: "a@b.com", csrfToken: "csrf-legacy" },
      ),
    });
    expect(result.csrfToken).toBe("csrf-legacy");
    expect(result.user).toEqual({ id: "u1", email: "a@b.com" });
    expect((result.user as Record<string, unknown>).csrfToken).toBeUndefined();
  });

  it("login strips a reserved csrfToken even if a nested user accidentally contains one", async () => {
    const result = await login("a@b.com", "pw", {
      fetchImpl: fakeFetch(
        200,
        { user: { id: "u1", email: "a@b.com", csrfToken: "bad" }, csrfToken: "good" },
      ),
    });
    expect(result.csrfToken).toBe("good");
    expect(result.user).toEqual({ id: "u1", email: "a@b.com" });
    expect((result.user as Record<string, unknown>).csrfToken).toBeUndefined();
  });

  it("fetchMe sends credentials:include and splits user from csrfToken on 200", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const me = await fetchMe({
      fetchImpl: fakeFetch(
        200,
        { user: { id: "u1", email: "a@b.com" }, csrfToken: "csrf-me" },
        cap,
      ),
    });
    expect(cap.url).toBe("https://health-api.mogubusi.trade/auth/me");
    expect(cap.init?.credentials).toBe("include");
    // The csrfToken is re-surfaced by /auth/me (logout-after-reload fix) and split
    // out of the user fields, exactly like login does.
    expect(me?.user).toEqual({ id: "u1", email: "a@b.com" });
    expect((me?.user as Record<string, unknown>).csrfToken).toBeUndefined();
    expect(me?.csrfToken).toBe("csrf-me");
  });

  it("fetchMe strips a reserved csrfToken even if a nested user accidentally contains one", async () => {
    const me = await fetchMe({
      fetchImpl: fakeFetch(
        200,
        { user: { id: "u1", email: "a@b.com", csrfToken: "bad" }, csrfToken: "good" },
      ),
    });
    expect(me?.csrfToken).toBe("good");
    expect(me?.user).toEqual({ id: "u1", email: "a@b.com" });
    expect((me?.user as Record<string, unknown>).csrfToken).toBeUndefined();
  });

  it("fetchMe returns null on 401 (so the gate shows login, not an error)", async () => {
    const me = await fetchMe({ fetchImpl: fakeFetch(401, { error: "no" }) });
    expect(me).toBeNull();
  });
});

describe("authApi — CSRF on logout (state-changing)", () => {
  it("sends X-CSRF-Token + credentials:include when a token is present", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    await logout("csrf-123", { fetchImpl: fakeFetch(200, {}, cap) });
    expect(cap.url).toBe("https://health-api.mogubusi.trade/auth/logout");
    expect(cap.init?.method).toBe("POST");
    expect(cap.init?.credentials).toBe("include");
    expect((cap.init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-123",
    );
  });

  it("omits the CSRF header when there is no token", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    await logout(null, { fetchImpl: fakeFetch(200, {}, cap) });
    expect(
      (cap.init?.headers as Record<string, string>)["X-CSRF-Token"],
    ).toBeUndefined();
  });

  it("does not throw on a non-2xx logout (UI clears state regardless)", async () => {
    await expect(
      logout("csrf", { fetchImpl: fakeFetch(500, {}) }),
    ).resolves.toBeUndefined();
  });
});

describe("authApi — error mapping", () => {
  it("login 401 → AuthApiError with a generic credentials message", async () => {
    await expect(
      login("a@b.com", "bad", { fetchImpl: fakeFetch(401, {}) }),
    ).rejects.toMatchObject({
      name: "AuthApiError",
      status: 401,
      message: "メールアドレスかパスワードが違います",
    });
  });

  it("register failure surfaces the server message", async () => {
    await expect(
      register("a@b.com", "pw", {
        fetchImpl: fakeFetch(409, { message: "既に登録済みです" }),
      }),
    ).rejects.toMatchObject({ status: 409, message: "既に登録済みです" });
  });

  it("AuthApiError carries the HTTP status for the UI to branch on", () => {
    const e = new AuthApiError(503, "準備中");
    expect(e.status).toBe(503);
    expect(e).toBeInstanceOf(Error);
  });
});

describe("authApi — calendarToday (READ existing events, day-planner)", () => {
  it("GETs /api/calendar/today with the day window + credentials (no CSRF on a read)", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const res = await calendarToday(
      { timeMin: "2026-06-26T00:00:00+09:00", timeMax: "2026-06-27T00:00:00+09:00" },
      {
        fetchImpl: fakeFetch(
          200,
          {
            events: [
              { summary: "会議", start: "2026-06-26T10:00:00+09:00", end: "2026-06-26T11:00:00+09:00", allDay: false },
            ],
          },
          cap,
        ),
      },
    );
    expect(cap.init?.method).toBe("GET");
    expect(cap.init?.credentials).toBe("include");
    // No CSRF header on a read.
    expect((cap.init?.headers as Record<string, string> | undefined)?.["X-CSRF-Token"]).toBeUndefined();
    expect(cap.url).toContain("/api/calendar/today?");
    expect(cap.url).toContain(encodeURIComponent("2026-06-26T00:00:00+09:00"));
    expect(res.notConnected).toBe(false);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toEqual({
      summary: "会議",
      start: "2026-06-26T10:00:00+09:00",
      end: "2026-06-26T11:00:00+09:00",
      allDay: false,
    });
  });

  it("a 409 maps to notConnected (no throw — the planner then prompts to connect)", async () => {
    const res = await calendarToday(undefined, { fetchImpl: fakeFetch(409, { error: "calendar_not_connected" }) });
    expect(res.notConnected).toBe(true);
    expect(res.events).toEqual([]);
  });

  it("drops malformed events from the response (never fabricates a time)", async () => {
    const res = await calendarToday(undefined, {
      fetchImpl: fakeFetch(200, {
        events: [
          { summary: "ok", start: "2026-06-26T10:00:00+09:00", end: "2026-06-26T11:00:00+09:00", allDay: false },
          { summary: "no-times" }, // missing start/end → dropped
          "garbage",
        ],
      }),
    });
    expect(res.events).toHaveLength(1);
    expect(res.events[0].summary).toBe("ok");
  });

  it("throws AuthApiError on a non-2xx (caller omits events honestly)", async () => {
    await expect(
      calendarToday(undefined, { fetchImpl: fakeFetch(502, { message: "読み取れません" }) }),
    ).rejects.toMatchObject({ name: "AuthApiError", status: 502 });
  });
});

describe("authApi — fetch impl default", () => {
  it("falls back to the global fetch when none is injected", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ email: "a@b.com" }),
      } as unknown as Response);
    const me = await fetchMe();
    expect(spy).toHaveBeenCalled();
    expect(me?.user).toEqual({ email: "a@b.com" });
    spy.mockRestore();
  });
});

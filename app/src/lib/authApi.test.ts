import { describe, it, expect, vi } from "vitest";
import {
  HEALTH_API_BASE,
  register,
  login,
  fetchMe,
  logout,
  googleStartUrl,
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
  it("derives every URL from HEALTH_API_BASE (the single source of truth)", () => {
    // HEALTH_API_BASE comes from NEXT_PUBLIC_HEALTH_API or the bundled
    // placeholder default; tests assert against it (not a hardcoded host) so
    // forks that set their own NEXT_PUBLIC_HEALTH_API still pass.
    expect(googleStartUrl()).toBe(`${HEALTH_API_BASE}/auth/google/start`);
  });
});

describe("authApi — cross-subdomain credentials", () => {
  it("register sends credentials:include + JSON body to /auth/register", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const res = await register("a@b.com", "pw", {
      fetchImpl: fakeFetch(202, { ok: true, message: "登録しました。" }, cap),
    });
    expect(res.ok).toBe(true);
    expect(cap.url).toBe(`${HEALTH_API_BASE}/auth/register`);
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
        { id: "u1", email: "a@b.com", csrfToken: "csrf-123" },
        cap,
      ),
    });
    expect(cap.init?.credentials).toBe("include");
    expect(result.csrfToken).toBe("csrf-123");
    expect(result.user).toEqual({ id: "u1", email: "a@b.com" });
    expect((result.user as Record<string, unknown>).csrfToken).toBeUndefined();
  });

  it("fetchMe sends credentials:include and splits user from csrfToken on 200", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const me = await fetchMe({
      fetchImpl: fakeFetch(
        200,
        { id: "u1", email: "a@b.com", csrfToken: "csrf-me" },
        cap,
      ),
    });
    expect(cap.url).toBe(`${HEALTH_API_BASE}/auth/me`);
    expect(cap.init?.credentials).toBe("include");
    // The csrfToken is re-surfaced by /auth/me (logout-after-reload fix) and split
    // out of the user fields, exactly like login does.
    expect(me?.user).toEqual({ id: "u1", email: "a@b.com" });
    expect((me?.user as Record<string, unknown>).csrfToken).toBeUndefined();
    expect(me?.csrfToken).toBe("csrf-me");
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
    expect(cap.url).toBe(`${HEALTH_API_BASE}/auth/logout`);
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

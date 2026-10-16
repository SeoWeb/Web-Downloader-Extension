import { describe, it, expect, afterEach, vi } from "vitest";

// env.ts parses process.env at import time — seed before importing the module.
process.env.NEXT_PUBLIC_API_BASE_URL ||= "http://localhost:8090/api/v1";
process.env.NEXT_PUBLIC_MARKETING_SITE_URL ||= "http://localhost:3000";
process.env.COOKIE_SECRET ||= "test-cookie-secret";

const { setAuthCookies, clearAuthCookies } = await import("@/lib/auth/cookies");

type CookieCall = { name: string; value: string; opts: { expires?: Date; maxAge?: number } };

function collector() {
  const calls: CookieCall[] = [];
  return {
    calls,
    set(name: string, value: string, opts: CookieCall["opts"]) {
      calls.push({ name, value, opts });
    },
  };
}

function cookie(calls: CookieCall[], name: string): CookieCall | undefined {
  return calls.find((c) => c.name === name);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("setAuthCookies — session cookie lifetime (D10)", () => {
  it("issues pp_access with a 30-day lifetime, not the 1h access-token TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const store = collector();
    setAuthCookies(store, { access: "a.token.value", refresh: "r" });

    const access = cookie(store.calls, "pp_access")!;
    const expected = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(access.opts.expires?.getTime()).toBe(expected.getTime());
  });

  it("issues pp_refresh with the same 30-day lifetime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const store = collector();
    setAuthCookies(store, { access: "a", refresh: "r" });

    const refresh = cookie(store.calls, "pp_refresh")!;
    const expected = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(refresh.opts.expires?.getTime()).toBe(expected.getTime());
    expect(refresh.value).toBe("r");
  });

  it("never writes an empty pp_refresh cookie", () => {
    for (const refresh of ["", undefined]) {
      const store = collector();
      setAuthCookies(store, { access: "a", ...(refresh ? { refresh } : {}) });

      expect(cookie(store.calls, "pp_access")).toBeDefined();
      expect(cookie(store.calls, "pp_refresh")).toBeUndefined();
    }
  });
});

describe("clearAuthCookies", () => {
  it("expires both cookies immediately", () => {
    const store = collector();
    clearAuthCookies(store);

    expect(cookie(store.calls, "pp_access")?.opts.maxAge).toBe(0);
    expect(cookie(store.calls, "pp_refresh")?.opts.maxAge).toBe(0);
  });
});

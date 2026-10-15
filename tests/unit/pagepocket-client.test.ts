/**
 * Tests for PagePocketClient auth persistence (D11 / task 7.2).
 *
 * Auth state (access/refresh tokens) must persist in chrome.storage.session
 * — cleared when the browser closes — and never in chrome.storage.local
 * (on disk). Leftover tokens written by older versions into local storage
 * are scrubbed on the first storage read.
 */

import { PagePocketClient } from "../../src/background/pagepocket-client";

const AUTH_KEY = "pagepocket_auth";

// ---------------------------------------------------------------------------
// chrome.storage mocks (setup.cjs only provides storage.local get/set)
// ---------------------------------------------------------------------------

const sessionStore: Record<string, unknown> = {};

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).session = {
    _store: sessionStore, // Exposed for test cleanup/assertions
    get: async (keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const k of keyArr) {
        if (sessionStore[k] !== undefined) {
          result[k] = sessionStore[k];
        }
      }
      return result;
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(sessionStore, items);
    },
    remove: async (keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      for (const k of keyArr) {
        delete sessionStore[k];
      }
    },
  };

  const localArea = globalThis.chrome.storage.local as Record<
    string,
    unknown
  > & { _store: Record<string, unknown> };
  if (typeof localArea.remove !== "function") {
    localArea.remove = async (keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      for (const k of keyArr) {
        delete localArea._store[k];
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(
  status: number,
  body: unknown = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authPayload(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "user-1", email: "user@example.com" },
    ...overrides,
  };
}

function localStore(): Record<string, unknown> {
  return (globalThis.chrome?.storage?.local?._store ?? {}) as Record<
    string,
    unknown
  >;
}

describe("PagePocketClient auth persistence", () => {
  let fetchSpy: vi.SpiedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.clearAllMocks();
    Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
    const store = globalThis.chrome?.storage?.local?._store as
      | Record<string, unknown>
      | undefined;
    if (store) {
      Object.keys(store).forEach((k) => delete store[k]);
    }
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("login persists auth state to chrome.storage.session, not local", async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/auth/login")) {
        return mockResponse(200, authPayload());
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    const state = await client.login("user@example.com", "pw");

    expect(state.accessToken).toBe("access-1");
    expect(sessionStore[AUTH_KEY]).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      user: { id: "user-1" },
    });
    // Nothing may land in the on-disk local area
    expect(localStore()[AUTH_KEY]).toBeUndefined();
  });

  it("logout removes the auth state from session storage", async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/auth/login")) {
        return mockResponse(200, authPayload());
      }
      if (urlStr.includes("/auth/logout")) {
        return new Response(null, { status: 204 });
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    await client.login("user@example.com", "pw");
    expect(sessionStore[AUTH_KEY]).toBeDefined();

    await client.logout();
    expect(sessionStore[AUTH_KEY]).toBeUndefined();
  });

  it("picks up persisted auth from session storage for authenticated calls", async () => {
    // Simulate a login from earlier in this browser session (new client
    // instance → empty in-memory state, auth must come from storage).
    sessionStore[AUTH_KEY] = {
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "user-1", email: "user@example.com" },
    };

    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/archive/pages/ingest")) {
        const h = init?.headers as Headers;
        expect(h?.get?.("Authorization")).toBe("Bearer stored-access");
        return mockResponse(200, { success: true, page_id: "p1", message: "ok", api_version: "v1" });
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    const result = await client.ingestPage({
      url: "https://example.com",
      htmlContent: new Blob(["<html></html>"]),
    });

    expect(result.page_id).toBe("p1");
  });

  it("refreshes an expired session token and updates session storage", async () => {
    sessionStore[AUTH_KEY] = {
      accessToken: "expired-access",
      refreshToken: "stored-refresh",
      expiresAt: Math.floor(Date.now() / 1000) - 60, // expired
      user: { id: "user-1", email: "user@example.com" },
    };

    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/auth/refresh")) {
        expect(JSON.parse(init?.body as string).refresh_token).toBe(
          "stored-refresh",
        );
        return mockResponse(200, {
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      if (urlStr.includes("/archive/pages/ingest")) {
        const h = init?.headers as Headers;
        expect(h?.get?.("Authorization")).toBe("Bearer fresh-access");
        return mockResponse(200, { success: true, page_id: "p2", message: "ok", api_version: "v1" });
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    await client.ingestPage({
      url: "https://example.com",
      htmlContent: new Blob(["<html></html>"]),
    });

    expect(sessionStore[AUTH_KEY]).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
    });
  });

  it("scrubs legacy auth state from chrome.storage.local on load", async () => {
    localStore()[AUTH_KEY] = {
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "user-legacy" },
    };

    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/archive/pages/ingest")) {
        // Session storage was empty → not authenticated; the call must not
        // fall back to the legacy on-disk token.
        const h = init?.headers as Headers;
        expect(h?.get?.("Authorization")).toBe("Bearer stored-access");
        return mockResponse(200, { success: true, page_id: "p3", message: "ok", api_version: "v1" });
      }
      return mockResponse(404, {});
    });

    sessionStore[AUTH_KEY] = {
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "user-1", email: "user@example.com" },
    };

    const client = new PagePocketClient();
    await client.ingestPage({
      url: "https://example.com",
      htmlContent: new Blob(["<html></html>"]),
    });

    expect(localStore()[AUTH_KEY]).toBeUndefined();
  });
});

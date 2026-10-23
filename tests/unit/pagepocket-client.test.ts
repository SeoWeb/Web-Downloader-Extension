/**
 * Tests for PagePocketClient auth persistence.
 *
 * D11 / task 7.2 baseline: auth state persists in chrome.storage.session
 * (cleared when the browser closes) and never in chrome.storage.local.
 *
 * easier-auth D1/D3/D8: with keep-signed-in opted in, exactly the refresh
 * token + user record (plus the cloud binding) are mirrored to
 * chrome.storage.local; the access token and expiry NEVER touch disk.
 * Persisted copies are cleared on logout, refresh failure, and
 * keep-signed-in-OFF logins.
 */

import {
  PagePocketAuthError,
  PagePocketClient,
} from "../../src/background/pagepocket-client";
import {
  PAGEPOCKET_AUTH_PERSISTED_KEY,
  PAGEPOCKET_AUTH_STORAGE_KEY,
  PAGEPOCKET_CLOUD_BINDING_KEY,
} from "../../src/types/authTypes";

const AUTH_KEY = PAGEPOCKET_AUTH_STORAGE_KEY;
const PERSISTED_KEY = PAGEPOCKET_AUTH_PERSISTED_KEY;
const BINDING_KEY = PAGEPOCKET_CLOUD_BINDING_KEY;

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

function mockResponse(status: number, body: unknown = {}): Response {
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

    fetchSpy.mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/archive/pages/ingest")) {
          const h = init?.headers as Headers;
          expect(h?.get?.("Authorization")).toBe("Bearer stored-access");
          return mockResponse(200, {
            success: true,
            page_id: "p1",
            message: "ok",
            api_version: "v1",
          });
        }
        return mockResponse(404, {});
      },
    );

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

    fetchSpy.mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
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
          return mockResponse(200, {
            success: true,
            page_id: "p2",
            message: "ok",
            api_version: "v1",
          });
        }
        return mockResponse(404, {});
      },
    );

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

    fetchSpy.mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/archive/pages/ingest")) {
          // Session storage was empty → not authenticated; the call must not
          // fall back to the legacy on-disk token.
          const h = init?.headers as Headers;
          expect(h?.get?.("Authorization")).toBe("Bearer stored-access");
          return mockResponse(200, {
            success: true,
            page_id: "p3",
            message: "ok",
            api_version: "v1",
          });
        }
        return mockResponse(404, {});
      },
    );

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

// ---------------------------------------------------------------------------
// easier-auth D1/D3/D8 — keep-me-signed-in persistence
// ---------------------------------------------------------------------------

describe("PagePocketClient keep-signed-in persistence", () => {
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

  it("login with keepSignedIn persists only the refresh token + user to local", async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url.toString() : String(url);
      if (urlStr.includes("/auth/login")) {
        return mockResponse(200, authPayload());
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    await client.login("user@example.com", "pw", true);

    // Full state lives in session storage
    expect(sessionStore[AUTH_KEY]).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    // Only the refresh token + user land on disk — never the access token
    const persisted = localStore()[PERSISTED_KEY] as Record<string, unknown>;
    expect(persisted).toEqual({
      refreshToken: "refresh-1",
      user: { id: "user-1", email: "user@example.com" },
    });
    expect(JSON.stringify(localStore())).not.toContain("access-1");
    expect(localStore()[AUTH_KEY]).toBeUndefined();
  });

  it("login with keepSignedIn off removes stale persisted copies from local", async () => {
    localStore()[PERSISTED_KEY] = {
      refreshToken: "stale-refresh",
      user: { id: "user-stale" },
    };

    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url.toString() : String(url);
      if (urlStr.includes("/auth/login")) {
        return mockResponse(200, authPayload());
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    await client.login("user@example.com", "pw", false);

    expect(localStore()[PERSISTED_KEY]).toBeUndefined();
    expect(sessionStore[AUTH_KEY]).toBeDefined();
  });

  it("refresh rotation updates the persisted refresh token in session and local", async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url.toString() : String(url);
      if (urlStr.includes("/auth/login")) {
        return mockResponse(200, authPayload());
      }
      if (urlStr.includes("/auth/refresh")) {
        return mockResponse(200, {
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    await client.login("user@example.com", "pw", true);
    await client.refreshToken();

    expect(sessionStore[AUTH_KEY]).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    expect(localStore()[PERSISTED_KEY]).toMatchObject({
      refreshToken: "refresh-2",
    });
    expect(JSON.stringify(localStore())).not.toContain("access-2");
  });

  it("refresh rotation does not write local when keep-signed-in is inactive", async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url.toString() : String(url);
      if (urlStr.includes("/auth/login")) {
        return mockResponse(200, authPayload());
      }
      if (urlStr.includes("/auth/refresh")) {
        return mockResponse(200, {
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    await client.login("user@example.com", "pw", false);
    await client.refreshToken();

    expect(sessionStore[AUTH_KEY]).toMatchObject({ refreshToken: "refresh-2" });
    expect(localStore()[PERSISTED_KEY]).toBeUndefined();
  });

  it("logout wipes the persisted session and mirrored binding from local", async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url.toString() : String(url);
      if (urlStr.includes("/auth/login")) {
        return mockResponse(200, authPayload());
      }
      if (urlStr.includes("/auth/logout")) {
        return new Response(null, { status: 204 });
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    await client.login("user@example.com", "pw", true);
    localStore()[BINDING_KEY] = { status: "bound", pagepocketUserId: "u1" };
    sessionStore[BINDING_KEY] = { status: "bound", pagepocketUserId: "u1" };
    expect(localStore()[PERSISTED_KEY]).toBeDefined();

    await client.logout();

    expect(sessionStore[AUTH_KEY]).toBeUndefined();
    expect(sessionStore[BINDING_KEY]).toBeUndefined();
    expect(localStore()[PERSISTED_KEY]).toBeUndefined();
    expect(localStore()[BINDING_KEY]).toBeUndefined();
  });

  it("restorePersistedSession mints an access token from the persisted refresh token", async () => {
    localStore()[PERSISTED_KEY] = {
      refreshToken: "persisted-refresh",
      user: { id: "user-1", email: "user@example.com" },
    };

    fetchSpy.mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url.toString() : String(url);
        if (urlStr.includes("/auth/refresh")) {
          expect(JSON.parse(init?.body as string).refresh_token).toBe(
            "persisted-refresh",
          );
          return mockResponse(200, {
            access_token: "restored-access",
            refresh_token: "rotated-refresh",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          });
        }
        return mockResponse(404, {});
      },
    );

    const client = new PagePocketClient();
    const state = await client.restorePersistedSession();

    expect(state).not.toBeNull();
    expect(state!.accessToken).toBe("restored-access");
    expect(state!.user).toEqual({ id: "user-1", email: "user@example.com" });
    // Rotation re-persists the new refresh token on disk
    expect(localStore()[PERSISTED_KEY]).toMatchObject({
      refreshToken: "rotated-refresh",
    });
    expect(sessionStore[AUTH_KEY]).toMatchObject({
      accessToken: "restored-access",
    });
  });

  it("restorePersistedSession clears both storage areas when the refresh fails", async () => {
    localStore()[PERSISTED_KEY] = {
      refreshToken: "revoked-refresh",
      user: { id: "user-1", email: "user@example.com" },
    };
    localStore()[BINDING_KEY] = { status: "bound", pagepocketUserId: "u1" };

    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url.toString() : String(url);
      if (urlStr.includes("/auth/refresh")) {
        // Reuse detection revoked the token server-side
        return mockResponse(401, { detail: "Token reused or revoked" });
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    const state = await client.restorePersistedSession();

    expect(state).toBeNull();
    expect(localStore()[PERSISTED_KEY]).toBeUndefined();
    expect(localStore()[BINDING_KEY]).toBeUndefined();
    expect(sessionStore[AUTH_KEY]).toBeUndefined();
  });

  it("restorePersistedSession returns null without network calls when nothing is persisted", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("must not be called");
    });

    const client = new PagePocketClient();
    const state = await client.restorePersistedSession();

    expect(state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// keep-signed-in logout-on-restart — refresh race + rotation persistence
//
// (a) Two mounted components both fired initializeFromStorage →
//     restorePersistedSession, and the direct refreshToken() call bypassed
//     the mutex: two concurrent refreshes with the SAME refresh token trip
//     backend reuse detection, which revokes the whole token family → the
//     second refresh fails → clearAuth() → logged out on every restart.
// (b) In the MV3 service-worker context authState is null after a restart,
//     so refreshToken() dropped the rotated token ("if (this.authState)"
//     persist gate) while storage kept the now-revoked one.
// ---------------------------------------------------------------------------

describe("PagePocketClient refresh race + rotation persistence", () => {
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

  it("serializes concurrent restorePersistedSession calls — never the same refresh token twice", async () => {
    localStore()[PERSISTED_KEY] = {
      refreshToken: "persisted-refresh",
      user: { id: "user-1", email: "user@example.com" },
    };

    const refreshTokens: string[] = [];
    let refreshCallCount = 0;
    let releaseFirst: ((res: Response) => void) | undefined;
    const firstRefresh = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });

    fetchSpy.mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url.toString() : String(url);
        if (urlStr.includes("/auth/refresh")) {
          refreshCallCount++;
          refreshTokens.push(JSON.parse(init?.body as string).refresh_token);
          if (refreshCallCount === 1) {
            // Hold the first refresh in flight so the second caller must
            // contend with the mutex while it is pending.
            return firstRefresh;
          }
          return mockResponse(200, {
            access_token: `access-${refreshCallCount}`,
            refresh_token: `rotated-${refreshCallCount}`,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          });
        }
        return mockResponse(404, {});
      },
    );

    const client = new PagePocketClient();
    const both = Promise.all([
      client.restorePersistedSession(),
      client.restorePersistedSession(),
    ]);

    // Wait until the first refresh is on the wire, then release it with a
    // rotated token pair.
    await vi.waitFor(() =>
      expect(refreshTokens).toEqual(["persisted-refresh"]),
    );
    releaseFirst!(
      mockResponse(200, {
        access_token: "access-1",
        refresh_token: "rotated-1",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );

    const [a, b] = await both;

    // Exactly ONE refresh hit the wire while both callers were pending —
    // the mutex promise is shared, so the second caller joined the first
    // instead of re-sending the same (now spent) token.
    expect(refreshTokens).toEqual(["persisted-refresh"]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.accessToken).toBe("access-1");
    expect(b!.accessToken).toBe("access-1");
    expect(localStore()[PERSISTED_KEY]).toMatchObject({
      refreshToken: "rotated-1",
    });

    // A LATER restore runs its own refresh carrying the ROTATED token —
    // reusing "persisted-refresh" would trip reuse detection again.
    const c = await client.restorePersistedSession();
    expect(refreshTokens).toEqual(["persisted-refresh", "rotated-1"]);
    expect(c!.accessToken).toBe("access-2");
    expect(localStore()[PERSISTED_KEY]).toMatchObject({
      refreshToken: "rotated-2",
    });
  });

  it("refreshToken with authState null hydrates from the persisted slice and persists the rotation", async () => {
    // MV3 restart: fresh client instance, nothing in memory, only the
    // keep-signed-in slice on disk.
    localStore()[PERSISTED_KEY] = {
      refreshToken: "persisted-refresh",
      user: { id: "user-1", email: "user@example.com" },
    };

    fetchSpy.mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url.toString() : String(url);
        if (urlStr.includes("/auth/refresh")) {
          expect(JSON.parse(init?.body as string).refresh_token).toBe(
            "persisted-refresh",
          );
          return mockResponse(200, {
            access_token: "access-9",
            refresh_token: "rotated-9",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          });
        }
        return mockResponse(404, {});
      },
    );

    const client = new PagePocketClient();
    const access = await client.refreshToken();

    expect(access).toBe("access-9");
    // The rotated pair replaces the old copy in BOTH areas — dropping it
    // here kept the revoked token on disk and wiped the session on the
    // next restart.
    expect(sessionStore[AUTH_KEY]).toMatchObject({
      accessToken: "access-9",
      refreshToken: "rotated-9",
    });
    expect(localStore()[PERSISTED_KEY]).toMatchObject({
      refreshToken: "rotated-9",
    });
    // The access token still never touches disk
    expect(JSON.stringify(localStore())).not.toContain("access-9");
  });

  it("refreshToken with authState null hydrates from session storage without writing to disk", async () => {
    // Session-only auth (keep-signed-in off): expired copy in session
    // storage, nothing on disk.
    sessionStore[AUTH_KEY] = {
      accessToken: "expired-access",
      refreshToken: "session-refresh",
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      user: { id: "user-1", email: "user@example.com" },
    };

    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url.toString() : String(url);
      if (urlStr.includes("/auth/refresh")) {
        return mockResponse(200, {
          access_token: "access-8",
          refresh_token: "rotated-8",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      return mockResponse(404, {});
    });

    const client = new PagePocketClient();
    await client.refreshToken();

    expect(sessionStore[AUTH_KEY]).toMatchObject({
      accessToken: "access-8",
      refreshToken: "rotated-8",
    });
    // No keep-signed-in slice existed → no disk write may appear
    expect(localStore()[PERSISTED_KEY]).toBeUndefined();
  });

  it("refreshToken with authState null and nothing in storage throws instead of fabricating state", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("must not be called");
    });

    const client = new PagePocketClient();
    await expect(client.refreshToken()).rejects.toBeInstanceOf(
      PagePocketAuthError,
    );
    expect(sessionStore[AUTH_KEY]).toBeUndefined();
    expect(localStore()[PERSISTED_KEY]).toBeUndefined();
  });
});

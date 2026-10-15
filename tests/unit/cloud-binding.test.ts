/**
 * Unit tests for the cloud binding orchestration (task 6.5 / design D4 —
 * harden-backend-security-and-ops).
 *
 * The HTTP contract of POST /api/v1/cloud/link is covered in
 * server-client.test.ts (linkCloudAccount); these tests cover the
 * orchestration: persistence of the binding state in chrome.storage.session,
 * the lazy ensure flow used by cloud-mode session creation, forced re-binding
 * after a 403 cloud_not_linked, and cleanup on logout / rejected tokens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — the ServerClient/PagePocketClient HTTP contracts are tested
// elsewhere; here we control their outcomes directly.
// ---------------------------------------------------------------------------

const linkCloudAccountMock = vi.fn();

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    linkCloudAccount: (...args: unknown[]) => linkCloudAccountMock(...args),
  },
}));

const refreshTokenMock = vi.fn();

vi.mock("../../src/background/pagepocket-client", () => ({
  pagepocketClient: {
    refreshToken: (...args: unknown[]) => refreshTokenMock(...args),
  },
}));

// ---------------------------------------------------------------------------
// chrome.storage.session mock (same pattern as server-client.test.ts —
// tests/setup.cjs only provides chrome.storage.local).
// ---------------------------------------------------------------------------

const sessionStore: Record<string, unknown> = {};

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).session = {
    _store: sessionStore,
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
}

import {
  clearCloudBinding,
  ensureCloudBinding,
  getCloudBinding,
  linkCloudAccount,
} from "../../src/background/cloud-binding";
import {
  PAGEPOCKET_AUTH_STORAGE_KEY,
  PAGEPOCKET_CLOUD_BINDING_KEY,
  type PagePocketAuthState,
} from "../../src/types/authTypes";

const AUTH_KEY = PAGEPOCKET_AUTH_STORAGE_KEY;
const BINDING_KEY = PAGEPOCKET_CLOUD_BINDING_KEY;

function seedAuth(overrides: Partial<PagePocketAuthState> = {}): PagePocketAuthState {
  const auth: PagePocketAuthState = {
    accessToken: "pp-access-token",
    refreshToken: "pp-refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "pp-user-1", email: "u@x.io", name: "U" },
    ...overrides,
  };
  sessionStore[AUTH_KEY] = auth;
  return auth;
}

describe("cloud binding (6.5 / D4)", () => {
  beforeEach(() => {
    Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
    linkCloudAccountMock.mockReset();
    refreshTokenMock.mockReset();
  });

  describe("linkCloudAccount", () => {
    it("links with the supplied token and persists the bound state", async () => {
      seedAuth();
      linkCloudAccountMock.mockResolvedValue({
        outcome: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
      });

      const { outcome, binding } = await linkCloudAccount("fresh-token");

      expect(outcome).toBe("bound");
      expect(linkCloudAccountMock).toHaveBeenCalledWith("fresh-token");
      expect(binding).toEqual({
        status: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
        linkedAt: expect.any(Number),
      });
      // Persisted for the cloud-mode credential resolution
      expect(sessionStore[BINDING_KEY]).toEqual(binding);
    });

    it("falls back to the stored auth token when none is supplied", async () => {
      seedAuth();
      linkCloudAccountMock.mockResolvedValue({
        outcome: "bound",
        pagepocketUserId: "pp-user-1",
        plan: null,
      });

      await linkCloudAccount();

      expect(linkCloudAccountMock).toHaveBeenCalledWith("pp-access-token");
    });

    it("refreshes an expired access token before linking", async () => {
      seedAuth({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
      refreshTokenMock.mockResolvedValue("refreshed-token");
      linkCloudAccountMock.mockResolvedValue({
        outcome: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "free",
      });

      const { outcome } = await linkCloudAccount();

      expect(outcome).toBe("bound");
      expect(refreshTokenMock).toHaveBeenCalledWith("pp-refresh-token");
      expect(linkCloudAccountMock).toHaveBeenCalledWith("refreshed-token");
    });

    it("persists the unsupported state for older servers (404/501/503)", async () => {
      seedAuth();
      linkCloudAccountMock.mockResolvedValue({ outcome: "unsupported" });

      const { outcome, binding } = await linkCloudAccount();

      expect(outcome).toBe("unsupported");
      expect(binding).toEqual({ status: "unsupported" });
      expect(sessionStore[BINDING_KEY]).toEqual({ status: "unsupported" });
    });

    it("clears a stale binding when the token is rejected", async () => {
      seedAuth();
      sessionStore[BINDING_KEY] = {
        status: "bound",
        pagepocketUserId: "pp-old",
        plan: "free",
        linkedAt: 1,
      };
      linkCloudAccountMock.mockResolvedValue({ outcome: "invalid_token" });

      const { outcome, binding } = await linkCloudAccount();

      expect(outcome).toBe("invalid_token");
      expect(binding).toBeNull();
      expect(sessionStore[BINDING_KEY]).toBeUndefined();
    });

    it("leaves existing state untouched on transient failure", async () => {
      seedAuth();
      const existing = {
        status: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
        linkedAt: 42,
      };
      sessionStore[BINDING_KEY] = existing;
      linkCloudAccountMock.mockResolvedValue({ outcome: "failed" });

      const { outcome, binding } = await linkCloudAccount();

      expect(outcome).toBe("failed");
      expect(binding).toEqual(existing);
      expect(sessionStore[BINDING_KEY]).toEqual(existing);
    });

    it("returns failed without calling the client when no auth exists", async () => {
      const { outcome, binding } = await linkCloudAccount();

      expect(outcome).toBe("failed");
      expect(binding).toBeNull();
      expect(linkCloudAccountMock).not.toHaveBeenCalled();
    });
  });

  describe("ensureCloudBinding (lazy path for session creation)", () => {
    it("returns the existing binding without a server call", async () => {
      const bound = {
        status: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
        linkedAt: 1,
      };
      sessionStore[BINDING_KEY] = bound;

      const result = await ensureCloudBinding();

      expect(result).toEqual(bound);
      expect(linkCloudAccountMock).not.toHaveBeenCalled();
    });

    it("attempts the link flow when no binding state exists yet", async () => {
      seedAuth();
      linkCloudAccountMock.mockResolvedValue({
        outcome: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
      });

      const result = await ensureCloudBinding();

      expect(linkCloudAccountMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        status: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
        linkedAt: expect.any(Number),
      });
    });

    it("short-circuits to null on unsupported servers (legacy raw-id fallback)", async () => {
      sessionStore[BINDING_KEY] = { status: "unsupported" };

      const result = await ensureCloudBinding();

      expect(result).toBeNull();
      expect(linkCloudAccountMock).not.toHaveBeenCalled();
    });

    it("returns null when the lazy link fails", async () => {
      seedAuth();
      linkCloudAccountMock.mockResolvedValue({ outcome: "failed" });

      const result = await ensureCloudBinding();

      expect(result).toBeNull();
    });

    it("force re-checks an unsupported server (403 cloud_not_linked retry)", async () => {
      seedAuth();
      sessionStore[BINDING_KEY] = { status: "unsupported" };
      linkCloudAccountMock.mockResolvedValue({
        outcome: "bound",
        pagepocketUserId: "pp-user-9",
        plan: "pro",
      });

      const result = await ensureCloudBinding({ force: true });

      expect(linkCloudAccountMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        status: "bound",
        pagepocketUserId: "pp-user-9",
        plan: "pro",
        linkedAt: expect.any(Number),
      });
    });

    it("force re-binds a bound-but-lost server-side identity (fresh registration)", async () => {
      seedAuth();
      sessionStore[BINDING_KEY] = {
        status: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
        linkedAt: 1,
      };
      linkCloudAccountMock.mockResolvedValue({
        outcome: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
      });

      const result = await ensureCloudBinding({ force: true });

      expect(linkCloudAccountMock).toHaveBeenCalledTimes(1);
      expect(result?.status).toBe("bound");
    });
  });

  describe("clearCloudBinding (logout)", () => {
    it("removes the persisted binding", async () => {
      sessionStore[BINDING_KEY] = {
        status: "bound",
        pagepocketUserId: "pp-user-1",
        plan: "pro",
        linkedAt: 1,
      };
      expect(await getCloudBinding()).not.toBeNull();

      await clearCloudBinding();

      expect(await getCloudBinding()).toBeNull();
      expect(sessionStore[BINDING_KEY]).toBeUndefined();
    });
  });
});

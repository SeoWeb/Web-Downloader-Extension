/**
 * Unit tests for resolveCloudCredential (task 6.5 / design D4 —
 * harden-backend-security-and-ops).
 *
 * Cloud-mode session creation must stop sending the raw pagepocketUserId as
 * the sole credential. The credential is now resolved from the server-side
 * binding state:
 *   bound       → send the BOUND id (matches the server binding; harmless)
 *   unsupported → legacy raw id (older monolith without /cloud/link)
 *   missing     → one lazy link attempt, then the legacy raw id as fallback
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Collaborator mocks
// ---------------------------------------------------------------------------

const getCloudBindingMock = vi.fn();
const ensureCloudBindingMock = vi.fn();

vi.mock("../../src/background/cloud-binding", () => ({
  getCloudBinding: (...args: unknown[]) => getCloudBindingMock(...args),
  ensureCloudBinding: (...args: unknown[]) => ensureCloudBindingMock(...args),
}));

vi.mock("../../src/background/server-client", () => {
  class HttpError extends Error {
    statusCode: number;
    errorCode?: string;
    constructor(message: string, statusCode: number, errorCode?: string) {
      super(message);
      this.name = "HttpError";
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }
  class ServerUnavailableError extends Error {
    constructor(message = "server unavailable") {
      super(message);
      this.name = "ServerUnavailableError";
    }
  }
  class AuthenticationError extends Error {
    constructor(message = "auth failed") {
      super(message);
      this.name = "AuthenticationError";
    }
  }
  class AssemblyTimeoutError extends Error {
    constructor(message = "assembly timeout") {
      super(message);
      this.name = "AssemblyTimeoutError";
    }
  }
  return {
    serverClient: { createSession: vi.fn() },
    HttpError,
    ServerUnavailableError,
    AuthenticationError,
    AssemblyTimeoutError,
  };
});

vi.mock("../../src/background/cleanupHandlers", () => ({
  cleanupAfterDownload: vi.fn(async () => {}),
}));
vi.mock("../../src/background/download-checkpoint", () => ({
  writeCheckpoint: vi.fn(async () => {}),
  updateCheckpointPhase: vi.fn(),
  updateCheckpointResourceUrls: vi.fn(async () => {}),
  clearCheckpoint: vi.fn(async () => {}),
}));
vi.mock("../../src/background/download-utils", () => ({
  performInitialCleanup: vi.fn(async () => {}),
}));
vi.mock("../../src/background/resources", () => ({
  getResources: vi.fn(() => ({
    images: [],
    css: [],
    js: [],
    links: [],
    documents: [],
    text: "",
  })),
}));
vi.mock("../../src/background/download-processors", () => ({
  processImages: vi.fn(),
  processAssets: vi.fn(),
  processDocuments: vi.fn(),
}));
vi.mock("../../src/background/linked-page-scraper", () => ({
  LinkedPageScraper: class {},
}));
vi.mock("../../src/background/storage/server-storage-adapter", () => ({
  ServerStorageAdapter: class {
    setSessionId() {}
    getUploadQueue() {
      return {};
    }
  },
}));
vi.mock("../../src/background/upload-queue", () => ({
  UploadQueue: class {},
}));
vi.mock("../../src/background/server-download", () => ({
  getServerDownloadHandler: vi.fn(),
  AssemblyFailedError: class extends Error {},
}));
vi.mock("../../src/background/scraper-state", () => ({
  setCurrentScraper: vi.fn(),
  stopScraping: vi.fn(),
}));
vi.mock("../../src/background/message", () => ({
  setActiveServerSession: vi.fn(),
  getActiveServerSessionId: vi.fn(() => null),
  hasStreamedHtmlChunks: vi.fn(() => false),
}));
vi.mock("../../src/common/storage/filterStorage", () => ({
  loadFilterOptions: vi.fn(async () => ({})),
}));

// ---------------------------------------------------------------------------
// chrome.storage.session mock (setup.cjs only provides chrome.storage.local)
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

import { resolveCloudCredential, createSessionWithCloudRetry } from "../../src/background/download-core";
import { serverClient, HttpError } from "../../src/background/server-client";
import {
  PAGEPOCKET_AUTH_STORAGE_KEY,
  PAGEPOCKET_CLOUD_ENABLED_KEY,
  type PagePocketAuthState,
} from "../../src/types/authTypes";

function seedCloudAuth(overrides: Partial<PagePocketAuthState> = {}): void {
  sessionStore[PAGEPOCKET_AUTH_STORAGE_KEY] = {
    accessToken: "pp-access-token",
    refreshToken: "pp-refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "raw-pp-user", email: "u@x.io", name: "U" },
    ...overrides,
  };
  sessionStore[PAGEPOCKET_CLOUD_ENABLED_KEY] = true;
}

describe("resolveCloudCredential (6.5 / D4)", () => {
  beforeEach(() => {
    Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
    getCloudBindingMock.mockReset();
    ensureCloudBindingMock.mockReset();
  });

  it("returns undefined when the cloud toggle is off", async () => {
    seedCloudAuth();
    sessionStore[PAGEPOCKET_CLOUD_ENABLED_KEY] = false;

    await expect(resolveCloudCredential()).resolves.toBeUndefined();
    expect(getCloudBindingMock).not.toHaveBeenCalled();
  });

  it("returns undefined without authenticated PagePocket auth", async () => {
    sessionStore[PAGEPOCKET_CLOUD_ENABLED_KEY] = true;
    sessionStore[PAGEPOCKET_AUTH_STORAGE_KEY] = {
      accessToken: "tok",
      user: undefined,
    };

    await expect(resolveCloudCredential()).resolves.toBeUndefined();
    expect(getCloudBindingMock).not.toHaveBeenCalled();
  });

  it("sends the BOUND id (not the raw user id) when a binding exists", async () => {
    seedCloudAuth();
    getCloudBindingMock.mockResolvedValue({
      status: "bound",
      pagepocketUserId: "bound-pp-user",
      plan: "pro",
      linkedAt: 1,
    });

    await expect(resolveCloudCredential()).resolves.toBe("bound-pp-user");
    expect(ensureCloudBindingMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy raw id when the server is unsupported", async () => {
    seedCloudAuth();
    getCloudBindingMock.mockResolvedValue({ status: "unsupported" });

    await expect(resolveCloudCredential()).resolves.toBe("raw-pp-user");
    // No link attempt against a server known to lack the endpoint
    expect(ensureCloudBindingMock).not.toHaveBeenCalled();
  });

  it("lazily links once when no binding state exists, then sends the bound id", async () => {
    seedCloudAuth();
    getCloudBindingMock.mockResolvedValue(null);
    ensureCloudBindingMock.mockResolvedValue({
      status: "bound",
      pagepocketUserId: "lazy-bound-user",
      plan: "free",
      linkedAt: 1,
    });

    await expect(resolveCloudCredential()).resolves.toBe("lazy-bound-user");
    expect(ensureCloudBindingMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy raw id when the lazy link fails", async () => {
    seedCloudAuth();
    getCloudBindingMock.mockResolvedValue(null);
    ensureCloudBindingMock.mockResolvedValue(null);

    // Older monoliths trust this field; newer ones answer 403
    // cloud_not_linked, which the session-creation wrapper converts into a
    // forced re-bind + retry.
    await expect(resolveCloudCredential()).resolves.toBe("raw-pp-user");
  });

  it("returns undefined when chrome.storage.session is unavailable", async () => {
    const session = (globalThis.chrome as any).storage?.session;
    if (session) delete (globalThis.chrome as any).storage.session;
    try {
      await expect(resolveCloudCredential()).resolves.toBeUndefined();
    } finally {
      if (session) (globalThis.chrome as any).storage.session = session;
    }
  });
});

describe("createSessionWithCloudRetry (6.5 — cloud_not_linked recovery)", () => {
  beforeEach(() => {
    vi.mocked(serverClient.createSession).mockReset();
    ensureCloudBindingMock.mockReset();
  });

  const NOT_LINKED = () =>
    new HttpError("createSession: 403 — no binding", 403, "cloud_not_linked");

  it("re-binds (forced) and retries once with the freshly bound id", async () => {
    vi.mocked(serverClient.createSession)
      .mockRejectedValueOnce(NOT_LINKED())
      .mockResolvedValueOnce("sess-retry-ok");
    ensureCloudBindingMock.mockResolvedValue({
      status: "bound",
      pagepocketUserId: "rebound-user",
      plan: "pro",
      linkedAt: 1,
    });

    const sessionId = await createSessionWithCloudRetry("https://example.com", {
      singleFile: false,
      retentionDays: 1,
      pagepocketUserId: "bound-pp-user",
    });

    expect(sessionId).toBe("sess-retry-ok");
    expect(serverClient.createSession).toHaveBeenCalledTimes(2);
    // The retry carries the FRESHLY bound id, not the stale one
    expect(vi.mocked(serverClient.createSession).mock.calls[1][1]).toEqual({
      singleFile: false,
      retentionDays: 1,
      pagepocketUserId: "rebound-user",
    });
    expect(ensureCloudBindingMock).toHaveBeenCalledWith({ force: true });
  });

  it("rethrows the original error when the forced re-bind fails", async () => {
    const original = NOT_LINKED();
    vi.mocked(serverClient.createSession).mockRejectedValue(original);
    ensureCloudBindingMock.mockResolvedValue(null);

    await expect(
      createSessionWithCloudRetry("https://example.com", {}),
    ).rejects.toBe(original);
    expect(serverClient.createSession).toHaveBeenCalledTimes(1);
  });

  it("rethrows cloud_identity_mismatch without a re-bind attempt", async () => {
    const mismatch = new HttpError(
      "createSession: 403 — mismatch",
      403,
      "cloud_identity_mismatch",
    );
    vi.mocked(serverClient.createSession).mockRejectedValue(mismatch);

    await expect(
      createSessionWithCloudRetry("https://example.com", {}),
    ).rejects.toBe(mismatch);
    expect(ensureCloudBindingMock).not.toHaveBeenCalled();
  });

  it("propagates unrelated errors untouched", async () => {
    const boom = new Error("413 session full");
    vi.mocked(serverClient.createSession).mockRejectedValue(boom);

    await expect(
      createSessionWithCloudRetry("https://example.com", {}),
    ).rejects.toBe(boom);
    expect(ensureCloudBindingMock).not.toHaveBeenCalled();
  });
});

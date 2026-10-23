/**
 * Single-flight initializeFromStorage (keep-signed-in logout-on-restart,
 * part a).
 *
 * SidePanel and PagePocketAnnouncement both mount usePagePocket(), and
 * every mount used to kick off its own initializeFromStorage(). Two
 * concurrent restores both reached restorePersistedSession(), which (via
 * the then-unmutexed refresh) sent the SAME refresh token twice — the
 * backend's reuse detection revoked the whole token family and the second
 * failure wiped the session. Concurrent calls must now share ONE in-flight
 * init promise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — HTTP contracts are covered in pagepocket-client.test.ts;
// here we control the outcomes directly (same pattern as the logout test).
// ---------------------------------------------------------------------------

const restorePersistedSessionMock = vi.fn();
const refreshTokenMock = vi.fn();
const logoutMock = vi.fn();

vi.mock("../../src/background/pagepocket-client", () => ({
  pagepocketClient: {
    restorePersistedSession: (...args: unknown[]) =>
      restorePersistedSessionMock(...args),
    refreshToken: (...args: unknown[]) => refreshTokenMock(...args),
    logout: (...args: unknown[]) => logoutMock(...args),
  },
  PagePocketAuthError: class PagePocketAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PagePocketAuthError";
    }
  },
}));

const clearCloudBindingMock = vi.fn();
const clearServerBindingMock = vi.fn();
const linkCloudAccountMock = vi.fn();
const restoreCloudBindingFromLocalMock = vi.fn();

vi.mock("../../src/background/cloud-binding", () => ({
  linkCloudAccount: (...args: unknown[]) => linkCloudAccountMock(...args),
  clearCloudBinding: (...args: unknown[]) => clearCloudBindingMock(...args),
  clearServerBinding: (...args: unknown[]) => clearServerBindingMock(...args),
  restoreCloudBindingFromLocal: (...args: unknown[]) =>
    restoreCloudBindingFromLocalMock(...args),
}));

// ---------------------------------------------------------------------------
// chrome.storage mock — setup.cjs provides storage.local only, but
// pagepocketStore.ts reads chrome.storage.session and registers an
// onChanged listener at module load.
// ---------------------------------------------------------------------------

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).session = {
    get: async () => ({}), // empty session store → restore path
    set: async () => {},
    remove: async () => {},
  };
  (globalThis.chrome.storage as Record<string, unknown>).onChanged = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

const { usePagePocketStore } = await import("../../src/stores/pagepocketStore");

describe("pagepocketStore.initializeFromStorage (single-flight)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreCloudBindingFromLocalMock.mockResolvedValue(undefined);
    clearCloudBindingMock.mockResolvedValue(undefined);
  });

  it("concurrent calls share one init promise — the restore effect runs once", async () => {
    // Hold the restore in flight so the second caller arrives while the
    // first is still pending.
    let releaseRestore: ((value: unknown) => void) | undefined;
    const restoreGate = new Promise((resolve) => {
      releaseRestore = resolve;
    });
    restorePersistedSessionMock.mockImplementation(() => restoreGate);

    const store = usePagePocketStore.getState();
    const p1 = store.initializeFromStorage();
    const p2 = store.initializeFromStorage();

    // Same shared promise — the second caller must not start a second
    // restore (that was the double-refresh race).
    expect(p2).toBe(p1);

    releaseRestore!({ user: { id: "user-1", email: "user@example.com" } });
    await p1;

    expect(restorePersistedSessionMock).toHaveBeenCalledTimes(1);
    expect(usePagePocketStore.getState().isAuthenticated).toBe(true);
    expect(usePagePocketStore.getState().authUser).toMatchObject({
      id: "user-1",
    });
  });

  it("clears the guard on completion — a later mount initializes afresh", async () => {
    restorePersistedSessionMock.mockResolvedValue({
      user: { id: "user-2", email: "user2@example.com" },
    });

    const first = usePagePocketStore.getState().initializeFromStorage();
    await first;

    const second = usePagePocketStore.getState().initializeFromStorage();
    expect(second).not.toBe(first);
    await second;

    expect(restorePersistedSessionMock).toHaveBeenCalledTimes(2);
  });

  it("the shared promise surfaces the restored user to both callers", async () => {
    let releaseRestore: ((value: unknown) => void) | undefined;
    const restoreGate = new Promise((resolve) => {
      releaseRestore = resolve;
    });
    restorePersistedSessionMock.mockImplementation(() => restoreGate);

    const p1 = usePagePocketStore.getState().initializeFromStorage();
    const p2 = usePagePocketStore.getState().initializeFromStorage();

    releaseRestore!({ user: { id: "user-3", email: "user3@example.com" } });
    await Promise.all([p1, p2]);

    expect(restorePersistedSessionMock).toHaveBeenCalledTimes(1);
    expect(usePagePocketStore.getState().authUser).toMatchObject({
      id: "user-3",
    });
  });
});

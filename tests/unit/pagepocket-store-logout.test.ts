/**
 * Unit tests for the PagePocket logout flow (close-cloud-lifecycle-gaps
 * D1 / task 3.2).
 *
 * The store is tested through the real zustand store with the network
 * clients mocked: logout must always complete — dropping local auth state —
 * even when the PagePocket logout endpoint and the fire-and-forget server
 * unbind (clearServerBinding) both fail.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — HTTP contracts are covered in pagepocket-client.test.ts /
// cloud-binding.test.ts; here we control the outcomes directly.
// ---------------------------------------------------------------------------

const logoutMock = vi.fn();

vi.mock("../../src/background/pagepocket-client", () => ({
  pagepocketClient: {
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

vi.mock("../../src/background/cloud-binding", () => ({
  linkCloudAccount: (...args: unknown[]) => linkCloudAccountMock(...args),
  clearCloudBinding: (...args: unknown[]) => clearCloudBindingMock(...args),
  clearServerBinding: (...args: unknown[]) => clearServerBindingMock(...args),
}));

// ---------------------------------------------------------------------------
// chrome.storage mock — setup.cjs provides storage.local only, but
// pagepocketStore.ts registers a storage.onChanged listener at module load.
// ---------------------------------------------------------------------------

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).onChanged = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

const { usePagePocketStore } = await import("../../src/stores/pagepocketStore");

describe("pagepocketStore.logout (server unbind is non-blocking)", () => {
  beforeEach(() => {
    logoutMock.mockReset();
    clearCloudBindingMock.mockReset();
    clearServerBindingMock.mockReset();
    linkCloudAccountMock.mockReset();
    usePagePocketStore.setState({ isAuthenticated: true, authUser: null });
  });

  it("logs out, clears the local binding, and unbinds on the server", async () => {
    logoutMock.mockResolvedValue(undefined);
    clearCloudBindingMock.mockResolvedValue(undefined);
    clearServerBindingMock.mockResolvedValue(undefined);
    usePagePocketStore.setState({
      isAuthenticated: true,
      authUser: { id: "pp-user-1", email: "u@x.io", name: "U" },
    });

    await usePagePocketStore.getState().logout();

    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(clearCloudBindingMock).toHaveBeenCalledTimes(1);
    expect(clearServerBindingMock).toHaveBeenCalledTimes(1);
    expect(usePagePocketStore.getState().isAuthenticated).toBe(false);
    expect(usePagePocketStore.getState().authUser).toBeNull();
  });

  it("completes logout even when the server unbind fails", async () => {
    logoutMock.mockResolvedValue(undefined);
    clearCloudBindingMock.mockResolvedValue(undefined);
    // clearServerBinding must never propagate a failure into logout —
    // and the store's own .catch guard is the last line of defense.
    clearServerBindingMock.mockRejectedValue(new Error("Monolith is down"));

    await expect(
      usePagePocketStore.getState().logout(),
    ).resolves.toBeUndefined();

    expect(clearServerBindingMock).toHaveBeenCalledTimes(1);
    expect(usePagePocketStore.getState().isAuthenticated).toBe(false);
    expect(usePagePocketStore.getState().authUser).toBeNull();
  });

  it("completes logout even when the PagePocket logout call fails", async () => {
    logoutMock.mockRejectedValue(new Error("PP auth service unreachable"));
    clearCloudBindingMock.mockResolvedValue(undefined);
    clearServerBindingMock.mockResolvedValue(undefined);

    await expect(
      usePagePocketStore.getState().logout(),
    ).resolves.toBeUndefined();

    expect(usePagePocketStore.getState().isAuthenticated).toBe(false);
  });
});

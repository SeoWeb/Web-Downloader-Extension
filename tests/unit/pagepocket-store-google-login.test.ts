/**
 * Unit tests for the store's Google login flow
 * (google-sign-in-via-background).
 *
 * chrome.identity.launchWebAuthFlow is unreliable from a side panel across
 * Chrome builds, so the PKCE flow moved to the background service worker:
 * the store now drives it with the GOOGLE_SIGN_IN message (repo convention:
 * sendMessageToBackground) instead of calling google-auth directly.
 *
 * Pinned here:
 * - the store sends GOOGLE_SIGN_IN and does NOT call launchGoogleSignIn
 *   directly;
 * - a structured {googleSignInError: code} reply is re-raised as the typed
 *   GoogleSignInError with the SAME code (the instanceof mapping in
 *   PagePocketAuth must keep working);
 * - on success the store proceeds to pagepocketClient.googleLogin with the
 *   same payload shape as before (code / code_verifier / redirect_uri).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { messageActions } from "../../src/common/message";
import { GoogleSignInError } from "../../src/background/google-auth";

// ---------------------------------------------------------------------------
// Module mocks — HTTP contracts are covered in pagepocket-client.test.ts;
// here we control the outcomes directly (same pattern as the logout test).
// ---------------------------------------------------------------------------

const googleLoginClientMock = vi.fn();

// pagepocketStore sends messages via client/message → common/chrome →
// background/message, which transitively loads background/jobs → download.ts;
// download.ts calls initializeDownloadListener() at module init, which needs
// chrome.downloads (not in the setup.cjs mock). Keep that graph out — same
// pattern as message-handler.test.ts.
vi.mock("../../src/background/jobs", () => ({
  scrollDownAndScrape: vi.fn(),
  startDownload: vi.fn(),
}));

vi.mock("../../src/background/pagepocket-client", () => ({
  pagepocketClient: {
    googleLogin: (...args: unknown[]) => googleLoginClientMock(...args),
  },
  PagePocketAuthError: class PagePocketAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PagePocketAuthError";
    }
  },
}));

const linkCloudAccountMock = vi.fn();
const clearCloudBindingMock = vi.fn();
const clearServerBindingMock = vi.fn();
const restoreCloudBindingFromLocalMock = vi.fn();

vi.mock("../../src/background/cloud-binding", () => ({
  linkCloudAccount: (...args: unknown[]) => linkCloudAccountMock(...args),
  clearCloudBinding: (...args: unknown[]) => clearCloudBindingMock(...args),
  clearServerBinding: (...args: unknown[]) => clearServerBindingMock(...args),
  restoreCloudBindingFromLocal: (...args: unknown[]) =>
    restoreCloudBindingFromLocalMock(...args),
}));

const sendMessageToBackgroundMock = vi.fn();

vi.mock("../../src/client/message", () => ({
  sendMessageToBackground: (...args: unknown[]) =>
    sendMessageToBackgroundMock(...args),
}));

// Keep the REAL GoogleSignInError class (the store's typed re-throw and the
// panel's instanceof mapping share it) and only stub the direct
// launchGoogleSignIn entry point — the store must never call it itself.
const directLaunchGoogleSignInMock = vi.fn();

vi.mock("../../src/background/google-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/background/google-auth")>();
  return {
    ...actual,
    launchGoogleSignIn: (...args: unknown[]) =>
      directLaunchGoogleSignInMock(...args),
  };
});

// ---------------------------------------------------------------------------
// chrome.storage mock — setup.cjs provides storage.local only, but
// pagepocketStore.ts reads chrome.storage.session and registers an
// onChanged listener at module load.
// ---------------------------------------------------------------------------

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).session = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
  };
  (globalThis.chrome.storage as Record<string, unknown>).onChanged = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

const { usePagePocketStore } = await import("../../src/stores/pagepocketStore");

describe("pagepocketStore.googleLogin (background-owned sign-in)", () => {
  const REDIRECT_URI =
    "https://aeojmgngnebhbjpncamiplkimkbnmpmk.chromiumapp.org/";
  const AUTH_REPLY = {
    code: "auth-code-1",
    codeVerifier: "verifier-1",
    redirectUri: REDIRECT_URI,
  };

  beforeEach(() => {
    sendMessageToBackgroundMock.mockReset();
    googleLoginClientMock.mockReset();
    directLaunchGoogleSignInMock.mockReset();
    clearCloudBindingMock.mockReset();
    clearServerBindingMock.mockReset();
    restoreCloudBindingFromLocalMock.mockReset();
    // Fire-and-forget in the store — it needs a settled promise to .catch.
    linkCloudAccountMock.mockReset();
    linkCloudAccountMock.mockResolvedValue(undefined);
    usePagePocketStore.setState({
      isAuthenticated: false,
      authUser: null,
      isAuthLoading: false,
    });
  });

  it("sends GOOGLE_SIGN_IN to the background and proceeds to the client exchange with the same payload", async () => {
    sendMessageToBackgroundMock.mockResolvedValue(AUTH_REPLY);
    googleLoginClientMock.mockResolvedValue({
      accessToken: "token-1",
      user: { id: "pp-user-1", email: "u@x.io", name: "U" },
    });

    await usePagePocketStore.getState().googleLogin(true);

    // The flow runs in the service worker — the store must not call the
    // direct google-auth entry point anymore.
    expect(directLaunchGoogleSignInMock).not.toHaveBeenCalled();
    expect(sendMessageToBackgroundMock).toHaveBeenCalledTimes(1);
    expect(sendMessageToBackgroundMock).toHaveBeenCalledWith(
      messageActions.GOOGLE_SIGN_IN,
      {},
    );
    // Same payload shape as before the message hop.
    expect(googleLoginClientMock).toHaveBeenCalledTimes(1);
    expect(googleLoginClientMock).toHaveBeenCalledWith(
      {
        code: "auth-code-1",
        code_verifier: "verifier-1",
        redirect_uri: REDIRECT_URI,
      },
      true,
    );
    // Same post-auth path as password login.
    expect(linkCloudAccountMock).toHaveBeenCalledWith("token-1");
    expect(usePagePocketStore.getState().isAuthenticated).toBe(true);
    expect(usePagePocketStore.getState().authUser).toMatchObject({
      id: "pp-user-1",
    });
    expect(usePagePocketStore.getState().isAuthLoading).toBe(false);
  });

  it("maps a structured {googleSignInError} reply to a typed GoogleSignInError throw with the same code", async () => {
    sendMessageToBackgroundMock.mockResolvedValue({
      googleSignInError: "cancelled",
    });

    const err: unknown = await usePagePocketStore
      .getState()
      .googleLogin(true)
      .then(
        () => {
          throw new Error("expected googleLogin to reject");
        },
        (e: unknown) => e,
      );

    // Same class identity as PagePocketAuth's instanceof mapping.
    expect(err).toBeInstanceOf(GoogleSignInError);
    expect((err as GoogleSignInError).code).toBe("cancelled");

    // The flow never got past the background — the client exchange and the
    // post-auth binding must not run.
    expect(googleLoginClientMock).not.toHaveBeenCalled();
    expect(linkCloudAccountMock).not.toHaveBeenCalled();
    expect(directLaunchGoogleSignInMock).not.toHaveBeenCalled();
    // The loading flag is reset before the throw surfaces in the panel.
    expect(usePagePocketStore.getState().isAuthLoading).toBe(false);
    expect(usePagePocketStore.getState().isAuthenticated).toBe(false);
  });
});

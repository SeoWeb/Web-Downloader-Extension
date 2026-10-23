import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { PagePocketUser } from "../types/authTypes";
import {
  PAGEPOCKET_AUTH_STORAGE_KEY,
  PAGEPOCKET_CLOUD_ENABLED_KEY,
} from "../types/authTypes";
import {
  pagepocketClient,
  PagePocketAuthError,
} from "../background/pagepocket-client";
import { launchGoogleSignIn } from "../background/google-auth";
import {
  linkCloudAccount,
  clearCloudBinding,
  clearServerBinding,
  restoreCloudBindingFromLocal,
} from "../background/cloud-binding";

interface PagePocketState {
  // State
  cloudStorageEnabled: boolean;
  isAuthenticated: boolean | undefined;
  authUser: PagePocketUser | null;
  isAuthLoading: boolean;

  // Actions
  setCloudStorageEnabled: (enabled: boolean) => void;
  login: (
    email: string,
    password: string,
    keepSignedIn: boolean,
  ) => Promise<void>;
  register: (
    email: string,
    password: string,
    name: string,
    keepSignedIn: boolean,
  ) => Promise<void>;
  /** easier-auth D4: passwordless Google sign-in (task 3.5). */
  googleLogin: (keepSignedIn: boolean) => Promise<void>;
  logout: () => Promise<void>;
  initializeFromStorage: () => Promise<void>;
}

// Single-flight guard for initializeFromStorage (see the store action).
let initPromise: Promise<void> | null = null;

export const usePagePocketStore = create<PagePocketState>()(
  subscribeWithSelector((set) => ({
    cloudStorageEnabled: false,
    isAuthenticated: undefined,
    authUser: null,
    isAuthLoading: false,

    setCloudStorageEnabled: (enabled) => {
      set({ cloudStorageEnabled: enabled });
      // D11 / task 7.2: PagePocket state lives in chrome.storage.session
      // (never on disk) — migrated from chrome.storage.local.
      chrome.storage.session
        .set({ [PAGEPOCKET_CLOUD_ENABLED_KEY]: enabled })
        .catch((err) => {
          console.warn("Failed to persist cloud storage toggle:", err);
        });
    },

    login: async (email, password, keepSignedIn) => {
      set({ isAuthLoading: true });
      try {
        // easier-auth D2: the checkbox choice decides whether this session
        // is persisted to chrome.storage.local (client storage layer).
        const authState = await pagepocketClient.login(
          email,
          password,
          keepSignedIn,
        );
        // Task 6.5 / D4: bind the PagePocket identity to the download server
        // (POST /api/v1/cloud/link). Best-effort and non-blocking — a slow or
        // unreachable monolith must never fail the login itself; the lazy
        // ensureCloudBinding() on the next cloud download covers transient
        // failures. ensureApiKey runs inside the link call, so "login without
        // a server API key yet" registers first, then binds.
        linkCloudAccount(authState.accessToken).catch((err) => {
          console.warn("[CloudBinding] link after login failed:", err);
        });
        set({
          isAuthenticated: true,
          authUser: authState.user,
          isAuthLoading: false,
        });
      } catch (err) {
        set({ isAuthLoading: false });
        throw err;
      }
    },

    register: async (email, password, name, keepSignedIn) => {
      set({ isAuthLoading: true });
      try {
        // easier-auth D2: same keep-signed-in semantics as login.
        const authState = await pagepocketClient.register(
          email,
          password,
          name,
          keepSignedIn,
        );
        // Task 6.5 / D4: same binding flow as login (registration on the
        // PagePocket side returns a fresh auth state).
        linkCloudAccount(authState.accessToken).catch((err) => {
          console.warn("[CloudBinding] link after register failed:", err);
        });
        set({
          isAuthenticated: true,
          authUser: authState.user,
          isAuthLoading: false,
        });
      } catch (err) {
        set({ isAuthLoading: false });
        throw err;
      }
    },

    /**
     * easier-auth D4/D7 (task 3.5): passwordless sign-in. Runs the PKCE
     * launchWebAuthFlow (google-auth.ts), exchanges the code via
     * POST /api/v1/auth/google, and finishes through the exact same
     * post-auth path as password login — saveAuth (session storage +
     * opt-in keep-signed-in mirror) and the fire-and-forget cloud binding.
     */
    googleLogin: async (keepSignedIn) => {
      set({ isAuthLoading: true });
      try {
        const { code, codeVerifier, redirectUri } = await launchGoogleSignIn();
        const authState = await pagepocketClient.googleLogin(
          { code, code_verifier: codeVerifier, redirect_uri: redirectUri },
          keepSignedIn,
        );
        // Task 6.5 / D4: same binding flow as login.
        linkCloudAccount(authState.accessToken).catch((err) => {
          console.warn("[CloudBinding] link after Google login failed:", err);
        });
        set({
          isAuthenticated: true,
          authUser: authState.user,
          isAuthLoading: false,
        });
      } catch (err) {
        set({ isAuthLoading: false });
        throw err;
      }
    },

    logout: async () => {
      try {
        await pagepocketClient.logout();
      } catch {
        // Clear local state even if server logout fails
      }
      // Task 6.5: the binding belongs to the logged-in identity — drop it so
      // a re-login with a different account re-binds instead of sending a
      // stale bound id.
      await clearCloudBinding();
      // close-cloud-lifecycle-gaps D1: also unbind the identity on the
      // server's client row (DELETE /api/v1/cloud/link) so a logout ends the
      // binding, not just the local session state. Fire-and-forget — logout
      // must never block or fail on the monolith being unreachable;
      // clearServerBinding already logs and swallows its own errors.
      void clearServerBinding().catch((err) => {
        console.warn("[CloudBinding] server unbind after logout failed:", err);
      });
      set({ isAuthenticated: false, authUser: null });
    },

    initializeFromStorage: () => {
      // Single-flight: SidePanel and PagePocketAnnouncement each mount
      // usePagePocket(), and every mount called this action. Two concurrent
      // runs both reached restorePersistedSession(), which (before the
      // refresh mutex covered that path) refreshed with the SAME refresh
      // token twice → backend reuse detection revoked the token family →
      // clearAuth() → logged out after every restart. Share one in-flight
      // promise instead; cleared in finally so a later mount re-initializes.
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          // D11 / task 7.2: read from chrome.storage.session (auth state and
          // the cloud toggle are session-only — migrated from storage.local).
          const result = await chrome.storage.session.get([
            PAGEPOCKET_CLOUD_ENABLED_KEY,
            PAGEPOCKET_AUTH_STORAGE_KEY,
          ]);

          const enabled =
            (result[PAGEPOCKET_CLOUD_ENABLED_KEY] as boolean) ?? false;
          const auth = result[PAGEPOCKET_AUTH_STORAGE_KEY] as {
            user?: PagePocketUser;
            expiresAt?: number;
          } | null;

          let authenticated = false;
          let user: PagePocketUser | null = null;

          if (auth?.user) {
            // Check if access token is still valid (with small buffer)
            const tokenValid =
              auth.expiresAt && Date.now() < auth.expiresAt * 1000 - 60_000;
            if (tokenValid) {
              authenticated = true;
              user = auth.user;
            } else {
              // Try refreshing the token
              try {
                await pagepocketClient.refreshToken();
                authenticated = true;
                // Re-read updated auth from session storage after refresh
                const updated = await chrome.storage.session.get(
                  PAGEPOCKET_AUTH_STORAGE_KEY,
                );
                const updatedAuth = updated[PAGEPOCKET_AUTH_STORAGE_KEY] as {
                  user?: PagePocketUser;
                } | null;
                user = updatedAuth?.user ?? auth.user;
              } catch {
                // Refresh failed — stay unauthenticated
              }
            }
          } else {
            // easier-auth D1 (task 1.4): session store empty — a keep-signed-in
            // session may be persisted on disk. Restore the refresh token +
            // user from chrome.storage.local and mint an access token via the
            // normal proactive refresh flow. On failure the client already
            // cleared both storage areas (D3); drop any stale binding too.
            const restored = await pagepocketClient.restorePersistedSession();
            if (restored) {
              authenticated = true;
              user = restored.user;
              // D8: bring the mirrored cloud binding back into session
              // storage alongside the restored refresh token.
              await restoreCloudBindingFromLocal();
            } else {
              await clearCloudBinding();
            }
          }

          set({
            cloudStorageEnabled: enabled,
            isAuthenticated: authenticated,
            authUser: user,
          });
        } catch (err) {
          if (err instanceof PagePocketAuthError) {
            set({ isAuthenticated: false, authUser: null });
          }
        } finally {
          initPromise = null;
        }
      })();
      return initPromise;
    },
  })),
);

// Cross-tab sync via chrome.storage.onChanged
if (typeof chrome !== "undefined" && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    // D11 / task 7.2: PagePocket state is session-scoped — accept the
    // "session" area (was "local").
    if (areaName !== "session") return;

    if (changes[PAGEPOCKET_CLOUD_ENABLED_KEY]) {
      const enabled = changes[PAGEPOCKET_CLOUD_ENABLED_KEY].newValue as boolean;
      usePagePocketStore.setState({ cloudStorageEnabled: enabled });
    }

    if (changes[PAGEPOCKET_AUTH_STORAGE_KEY]) {
      const auth = changes[PAGEPOCKET_AUTH_STORAGE_KEY].newValue as {
        user?: PagePocketUser;
      } | null;
      usePagePocketStore.setState({
        isAuthenticated: !!auth?.user,
        authUser: auth?.user ?? null,
      });
    }
  });
}

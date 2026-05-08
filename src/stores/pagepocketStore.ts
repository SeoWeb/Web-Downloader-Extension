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

interface PagePocketState {
  // State
  cloudStorageEnabled: boolean;
  isAuthenticated: boolean | undefined;
  authUser: PagePocketUser | null;
  isAuthLoading: boolean;

  // Actions
  setCloudStorageEnabled: (enabled: boolean) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  initializeFromStorage: () => Promise<void>;
}

export const usePagePocketStore = create<PagePocketState>()(
  subscribeWithSelector((set) => ({
    cloudStorageEnabled: false,
    isAuthenticated: undefined,
    authUser: null,
    isAuthLoading: false,

    setCloudStorageEnabled: (enabled) => {
      set({ cloudStorageEnabled: enabled });
      chrome.storage.local
        .set({ [PAGEPOCKET_CLOUD_ENABLED_KEY]: enabled })
        .catch((err) => {
          console.warn("Failed to persist cloud storage toggle:", err);
        });
    },

    login: async (email, password) => {
      set({ isAuthLoading: true });
      try {
        const authState = await pagepocketClient.login(email, password);
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

    register: async (email, password, name) => {
      set({ isAuthLoading: true });
      try {
        const authState = await pagepocketClient.register(
          email,
          password,
          name,
        );
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
      set({ isAuthenticated: false, authUser: null });
    },

    initializeFromStorage: async () => {
      try {
        const result = await chrome.storage.local.get([
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
              // Re-read updated auth from storage after refresh
              const updated = await chrome.storage.local.get(
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
      }
    },
  })),
);

// Cross-tab sync via chrome.storage.onChanged
if (typeof chrome !== "undefined" && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

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

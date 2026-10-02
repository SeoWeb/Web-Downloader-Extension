// src/store/userDataStore.ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { chromeStorage } from "../common/chrome/storage";

interface UserDataState {
  user_id: number | null;
  token: string | null;
  connection_id: number | null;
  setUserId: (id: number | null) => void;
  setToken: (token: string | null) => void;
  setConnectionId: (id: number | null) => void;
}

export const useUserDataStore = create<UserDataState>()(
  persist(
    (set) => ({
      user_id: null,
      token: null,
      connection_id: null,
      setUserId: (id) => set({ user_id: id }),
      setToken: (token) => set({ token: token }),
      setConnectionId: (id) => set({ connection_id: id }),
    }),
    {
      name: "user-data-storage", // unique name
      storage: createJSONStorage(() => chromeStorage), // Use chrome.storage.local
    },
  ),
);

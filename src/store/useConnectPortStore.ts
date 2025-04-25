// src/store/useConnectPortStore.ts
import { create } from "zustand";

interface UserDataState {
  port: chrome.runtime.Port | null;
  setPort: (port: chrome.runtime.Port | null) => void;
}

const initialState = {
  port: null,
};

export const useConnectPortStore = create<UserDataState>()((set) => ({
  ...initialState,
  setPort: (port) => set({ port }),
}));

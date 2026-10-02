// src/store/downloadSettingsStore.ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { chromeStorage } from "../common/chrome/storage";

export type FilterMode = "type" | "extension";
export type DownloadMode = "single_file" | "single" | "website";
export type ScrollMode = "auto" | "manual";

interface DownloadSettingsState {
  filterMode: FilterMode;
  selectedAssetTypes: string[];
  selectedExtensions: string[];
  downloadMode: DownloadMode;
  scrollMode: ScrollMode; // Added scrollMode
  activeTabId: number | null | undefined;
  isSidePanelOpen: boolean;
  setFilterMode: (mode: FilterMode) => void;
  setSelectedAssetTypes: (types: string[]) => void;
  toggleAssetType: (typeId: string) => void;
  setSelectedExtensions: (extensions: string[]) => void;
  toggleExtension: (extId: string) => void;
  setDownloadMode: (mode: DownloadMode) => void;
  setScrollMode: (mode: ScrollMode) => void; // Added setScrollMode
  setActiveTabId: (id: number | null) => void;
  setIsSidePanelOpen: (is: boolean) => void;
}

export const useDownloadSettingsStore = create<DownloadSettingsState>()(
  persist(
    (set) => ({
      filterMode: "type",
      selectedAssetTypes: ["image", "script", "stylesheet", "html", "font"],
      selectedExtensions: [
        "jpg",
        "png",
        "gif",
        "svg",
        "webp",
        "js",
        "css",
        "woff",
        "woff2",
        "html",
      ],
      downloadMode: "single",
      scrollMode: "auto", // Added scrollMode with default "auto"
      activeTabId: undefined,
      isSidePanelOpen: false,
      setFilterMode: (mode) => set({ filterMode: mode }),
      setSelectedAssetTypes: (types) => set({ selectedAssetTypes: types }),
      toggleAssetType: (typeId) =>
        set((state) => ({
          selectedAssetTypes: state.selectedAssetTypes.includes(typeId)
            ? state.selectedAssetTypes.filter((id) => id !== typeId)
            : [...state.selectedAssetTypes, typeId],
        })),
      setSelectedExtensions: (extensions) =>
        set({ selectedExtensions: extensions }),
      toggleExtension: (extId) =>
        set((state) => ({
          selectedExtensions: state.selectedExtensions.includes(extId)
            ? state.selectedExtensions.filter((id) => id !== extId)
            : [...state.selectedExtensions, extId],
        })),
      setDownloadMode: (mode) => set({ downloadMode: mode }),
      setScrollMode: (mode) => set({ scrollMode: mode }), // Added setScrollMode
      setActiveTabId: (id) => set({ activeTabId: id }),
      setIsSidePanelOpen: (is) => set({ isSidePanelOpen: is }),
    }),
    {
      name: "download-settings-storage", // unique name
      storage: createJSONStorage(() => chromeStorage), // Use chrome.storage.local
    },
  ),
);

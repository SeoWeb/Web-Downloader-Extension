import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { chromeStorage } from "../common/chrome/storage";

interface DownloadStatusState {
  isDownloading: boolean;
  actionsLog: string[];
  currentAction: string | null;
  setIsDownloading: (isDownloading: boolean) => void;
  setActionsLog: (actionsLog: string[]) => void;
  setCurrentAction: (action: string | null) => void;
  updateCurrentAction: (action: string | null) => void;
  reset: () => void;
}

const initialState = {
  isDownloading: false,
  actionsLog: [],
  currentAction: null,
};

export const useDownloadStatusStore = create<DownloadStatusState>()(
  persist(
    (set, get) => ({
      ...initialState,
      setIsDownloading: (isDownloading) => set({ isDownloading }),
      setActionsLog: (actionsLog) => set({ actionsLog }),
      setCurrentAction: (action) => {
        const currentAction = get().currentAction;

        if (currentAction) {
          set(({ actionsLog }) => ({
            actionsLog: [...actionsLog, currentAction],
          }));
        }

        set({ currentAction: action });
      },
      updateCurrentAction: (action) => set({ currentAction: action }),
      reset: () => set(initialState),
    }),
    {
      name: "download-status-storage", // unique name
      storage: createJSONStorage(() => chromeStorage), // Use chrome.storage.local
    },
  ),
);

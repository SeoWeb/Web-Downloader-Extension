export const downloadId = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export interface DownloadInfo {
  tabId: number;
  filename: string;
}

export const activeDownloads = new Map<number, DownloadInfo>();

/** AbortController for the currently active download.
 *  When the user presses "Stop", this controller is aborted,
 *  causing the upload queue and download flow to cancel. */
let downloadAbortController: AbortController | null = null;

export const getDownloadAbortController = () => downloadAbortController;
export const setDownloadAbortController = (controller: AbortController | null) => {
  downloadAbortController = controller;
};

/** Abort the active download (called when user presses Stop). */
export const abortActiveDownload = (): boolean => {
  if (downloadAbortController && !downloadAbortController.signal.aborted) {
    downloadAbortController.abort();
    return true;
  }
  return false;
};

let keepalivePort: chrome.runtime.Port | null = null;
export const getKeepalivePort = () => keepalivePort;
export const setKeepalivePort = (port: chrome.runtime.Port | null) => { keepalivePort = port; };

export const setDownloadInProgress = async (inProgress: boolean) => {
  if (chrome.storage && chrome.storage.local) {
    await chrome.storage.local.set({ isDownloadInProgress: inProgress });
  }
};

export const getDownloadInProgress = async (): Promise<boolean> => {
  if (chrome.storage && chrome.storage.local) {
    const result = await chrome.storage.local.get("isDownloadInProgress");
    return result.isDownloadInProgress ?? false;
  }
  return false;
};

export const trackDownload = (id: number, filename: string, tabId?: number) => {
    activeDownloads.set(id, {
        tabId: tabId || 0,
        filename,
    });
    
    // Create keepalive connection if not already exists
    if (!keepalivePort) {
        keepalivePort = chrome.runtime.connect({ name: "keepalive" });
    }
};

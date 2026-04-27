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
    disconnectKeepalivePort();
    return true;
  }
  return false;
};

let keepalivePort: chrome.runtime.Port | null = null;
export const getKeepalivePort = () => keepalivePort;
export const setKeepalivePort = (port: chrome.runtime.Port | null) => { keepalivePort = port; };

/** Create a keepalive port to prevent the service worker from being killed.
 *  Safe to call multiple times — reuses existing port. */
export function createKeepalivePort(): void {
  if (!keepalivePort) {
    keepalivePort = chrome.runtime.connect({ name: "download-keepalive" });
    console.log("[Keepalive] Port created");
  }
}

/** Disconnect the keepalive port, allowing the service worker to idle out. */
export function disconnectKeepalivePort(): void {
  if (keepalivePort) {
    keepalivePort.disconnect();
    keepalivePort = null;
    console.log("[Keepalive] Port disconnected");
  }
}

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
    
    // Reuse keepalive port if one was created at download start
    if (!keepalivePort) {
        keepalivePort = chrome.runtime.connect({ name: "download-keepalive" });
    }
};

export const downloadId = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export interface DownloadInfo {
  tabId: number;
  filename: string;
}

export const activeDownloads = new Map<number, DownloadInfo>();

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
        console.log("Created keepalive port to prevent service worker termination");
    }
    
    console.log(`Tracking download ${id}: ${filename}`);
};

export const downloadId = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export interface DownloadInfo {
  tabId?: number;
  filename: string;
}

export const activeDownloads = new Map<number, DownloadInfo>();

/** Per-tab AbortController map. When the user presses "Stop", the controller
 *  for that tab is aborted, causing the upload queue and download flow to cancel. */
const downloadAbortControllers = new Map<number, AbortController>();

export const getDownloadAbortController = (tabId: number) =>
  downloadAbortControllers.get(tabId) ?? null;
export const setDownloadAbortController = (
  controller: AbortController | null,
  tabId: number,
) => {
  if (controller) {
    downloadAbortControllers.set(tabId, controller);
  } else {
    downloadAbortControllers.delete(tabId);
  }
};

/** Abort the active download for a given tab (called when user presses Stop). */
export const abortActiveDownload = (tabId: number): boolean => {
  const controller = downloadAbortControllers.get(tabId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
    disconnectKeepalivePort(tabId);
    return true;
  }
  return false;
};

const keepalivePorts = new Map<number, chrome.runtime.Port>();
export const getKeepalivePort = (tabId: number) =>
  keepalivePorts.get(tabId) ?? null;
export const setKeepalivePort = (
  port: chrome.runtime.Port | null,
  tabId: number,
) => {
  if (port) {
    keepalivePorts.set(tabId, port);
  } else {
    keepalivePorts.delete(tabId);
  }
};

/** Create a keepalive port for a given tab to prevent the service worker from being killed.
 *  Safe to call multiple times — reuses existing port. */
export function createKeepalivePort(tabId: number): void {
  if (!keepalivePorts.has(tabId)) {
    const port = chrome.runtime.connect({ name: "download-keepalive" });
    // Respond to pings from the service worker to create bidirectional I/O
    port.onMessage.addListener((msg) => {
      if (msg.type === "keepalive-ping") {
        port.postMessage({ type: "keepalive-pong" });
      }
    });
    keepalivePorts.set(tabId, port);
    console.log("[Keepalive] Port created for tab", tabId);
  }
}

/** Disconnect the keepalive port for a given tab, allowing the service worker to idle out. */
export function disconnectKeepalivePort(tabId: number): void {
  const port = keepalivePorts.get(tabId);
  if (port) {
    port.disconnect();
    keepalivePorts.delete(tabId);
    console.log("[Keepalive] Port disconnected for tab", tabId);
  }
}

/** In-memory set of tab IDs with active downloads. O(1) lookup on hot path. */
const activeDownloadTabIds = new Set<number>();

export const setTabDownloadActive = async (tabId: number) => {
  activeDownloadTabIds.add(tabId);
  if (chrome.storage && chrome.storage.local) {
    await chrome.storage.local.set({ isDownloadInProgress: true });
  }
};

export const setTabDownloadComplete = async (tabId: number) => {
  activeDownloadTabIds.delete(tabId);
  if (chrome.storage && chrome.storage.local) {
    await chrome.storage.local.set({
      isDownloadInProgress: activeDownloadTabIds.size > 0,
    });
  }
};

export const isAnyDownloadInProgress = () => activeDownloadTabIds.size > 0;
export const isTabDownloadInProgress = (tabId: number) =>
  activeDownloadTabIds.has(tabId);

export const trackDownload = (id: number, filename: string, tabId?: number) => {
  activeDownloads.set(id, {
    tabId,
    filename,
  });

  // Reuse or create keepalive port for this tab
  if (tabId) createKeepalivePort(tabId);
};

/** Remove all tracked chrome.downloads entries for a given tab. */
export const removeDownloadsForTab = (tabId: number): void => {
  for (const [id, info] of activeDownloads) {
    if (info.tabId === tabId) {
      activeDownloads.delete(id);
    }
  }
};

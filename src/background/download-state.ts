export const downloadId = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

import type { UploadQueue } from "./upload-queue";

/**
 * Per-download context (D7 / task 4.1).
 *
 * All mutable state shared across the processors, handlers, and the linked
 * page scraper is scoped to a single download via this object instead of
 * module-level globals, so concurrent tab downloads cannot corrupt each
 * other's filename maps or dedup keys.
 */
export interface DownloadContext {
  /** Unique id for this download (fresh per downloadResources call). */
  downloadId: string;
  /** The tab this download runs in (when known). */
  tabId?: number;
  /** The main page URL being downloaded. */
  tabUrl: string;
  /** Server session id this download uploads to (when in server mode). */
  serverSessionId?: string;
  /**
   * Image filename map (original src → archive filename) shared between the
   * main page and all linked pages of THIS download. Replaces the former
   * module-global `globalImageFilenameMap`.
   */
  imageFilenameMap: Map<string, string>;
  /** Absolute URLs already processed for this download (dedup keys). */
  dedupKeys: Set<string>;
  /** Download-level abort controller (user pressed Stop). */
  abortController: AbortController;
  /** Abort controller for assembly-status polling of this download. */
  assemblyAbortController: AbortController;
  /** The upload queue handle for this download (server mode). */
  uploadQueue?: UploadQueue;
}

/** Create an empty per-download context. */
export function createDownloadContext(params: {
  tabId?: number;
  tabUrl: string;
  serverSessionId?: string;
  abortController: AbortController;
  uploadQueue?: UploadQueue;
}): DownloadContext {
  return {
    downloadId: `download-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`,
    tabId: params.tabId,
    tabUrl: params.tabUrl,
    serverSessionId: params.serverSessionId,
    imageFilenameMap: new Map<string, string>(),
    dedupKeys: new Set<string>(),
    abortController: params.abortController,
    assemblyAbortController: new AbortController(),
    uploadQueue: params.uploadQueue,
  };
}

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

/**
 * True when a download OTHER than the given tab's is currently active.
 *
 * Used to scope teardown (concurrent-downloads spec / design D7): the
 * finishing download may only run GLOBAL cleanup — `requestQueue.clear()`,
 * `memoryManager.forceCleanup()` — when it is the last active download.
 * While a peer download is still running, teardown must stay scoped so it
 * cannot abort the peer's in-flight fetches or drop its queued requests.
 */
export const isOtherDownloadActive = (ownTabId?: number): boolean => {
  for (const tabId of activeDownloadTabIds) {
    if (tabId !== ownTabId) return true;
  }
  return false;
};

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

// ---------------------------------------------------------------------------
// (Fix D.1 — liveness) Server-session liveness tracking.
//
// Checkpoints exist for the WHOLE duration of a download (they are the
// recovery manifest), so a panel that (re)opens mid-download would find one
// and wrongly offer Resume/Restart for a download that is actually still
// running. The background tracks the session ids of LIVE downloads here;
// the panel queries them via the CHECK_DOWNLOAD_LIVE message action.
// ---------------------------------------------------------------------------

const liveServerSessionIds = new Set<string>();

/** Mark a server session as live (called when its download starts/resumes). */
export function markSessionLive(sessionId: string): void {
  liveServerSessionIds.add(sessionId);
}

/** Mark a server session as no longer live (completion, failure, abort). */
export function markSessionNotLive(sessionId: string): void {
  liveServerSessionIds.delete(sessionId);
}

/** True when the given server session currently has a running download. */
export function isSessionLive(sessionId?: string): boolean {
  return !!sessionId && liveServerSessionIds.has(sessionId);
}

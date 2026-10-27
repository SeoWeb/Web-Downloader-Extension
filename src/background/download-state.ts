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
 *  for that tab is aborted (see abortActiveDownload) — all phase-specific
 *  cancellation (upload queue, resume re-fetch loop, assembly polling)
 *  flows from the abort listeners each flow registers on that signal. */
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

/**
 * Abort the active download for a given tab (called when user presses Stop).
 *
 * (stop-cancel-semantics D2 / task 1.5) This aborts ONLY the per-tab stop
 * controller — all phase-specific cancellation flows from the abort
 * listeners registered on its signal (upload-queue cancel + assembly-signal
 * abort on the main path; queue cancel + resume-assembly abort + stop-aware
 * re-fetch loop on the resume path). The assembly controllers themselves
 * are aborted by those listeners and by each flow's teardown (the
 * `finally` blocks in download-core.ts), so no poll outlives its flow.
 */
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

/**
 * Liveness hook invoked when a keepalive port disconnects (D2 / task 2.1).
 * scraper-state registers a handler that resolves the affected tab's paused
 * scraper wait with STOP semantics — when the port dies, the side panel is
 * gone and no context can deliver a resume anymore. Kept as a registered
 * hook (rather than a direct import) so download-state stays independent of
 * the scraper module graph.
 */
let keepaliveDisconnectHook: ((tabId: number) => void) | null = null;

export function setKeepaliveDisconnectHook(
  hook: ((tabId: number) => void) | null,
): void {
  keepaliveDisconnectHook = hook;
}

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
    // (D2 / task 2.1) The panel side dying fires onDisconnect HERE — the
    // observable signal that no UI remains to resume a paused scraper.
    // Forget the dead port (a reopened panel creates a fresh one) and run
    // the liveness hook; the hook is a no-op when nothing is paused, so
    // panel-reopen races are tolerated idempotently.
    port.onDisconnect.addListener(() => {
      if (keepalivePorts.get(tabId) === port) {
        keepalivePorts.delete(tabId);
      }
      try {
        keepaliveDisconnectHook?.(tabId);
      } catch (error) {
        console.warn("[Keepalive] Disconnect hook failed:", error);
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

/**
 * Mark a server session as live (called when its download starts/resumes).
 *
 * (Round 9 — Fix B) The optional meta records the run's tab and coarse
 * pipeline phase for the panel's CHECK_DOWNLOAD_LIVE snapshot, and clears
 * any terminal error left by a previous run of the same session.
 */
export function markSessionLive(
  sessionId: string,
  meta: { tabId?: number; phase?: string } = {},
): void {
  liveServerSessionIds.add(sessionId);
  const prev = liveSessionStates.get(sessionId);
  liveSessionStates.set(sessionId, {
    tabId: meta.tabId ?? prev?.tabId,
    phase: meta.phase ?? prev?.phase,
    uploadQueue: prev?.uploadQueue,
  });
  // A (re)started run must not inherit the previous run's failure.
  lastErrorBySession.delete(sessionId);
}

/** Mark a server session as no longer live (completion, failure, abort). */
export function markSessionNotLive(sessionId: string): void {
  liveServerSessionIds.delete(sessionId);
  // Drop the heavy runtime state (it holds the upload-queue reference) but
  // KEEP the terminal error — the panel performs one final poll after the
  // download stops and must still be able to tell "failed" from "completed".
  liveSessionStates.delete(sessionId);
}

/** True when the given server session currently has a running download. */
export function isSessionLive(sessionId?: string): boolean {
  return !!sessionId && liveServerSessionIds.has(sessionId);
}

// ---------------------------------------------------------------------------
// (Round 9 — Fix B) Per-session progress you can trust.
//
// Pushed PANEL_MESSAGEs are lossy: the panel drops them whenever the user
// focuses another tab, so its progress card can freeze on a stale count
// while the background runs on — and a terminal failure may never be shown
// at all (Round 9 incident: 351 images uploaded at full speed while the
// panel sat on "Images progress: 1/353"). The panel therefore polls
// CHECK_DOWNLOAD_LIVE, which answers from THIS authoritative state: the
// live/finished flag, the run's upload-queue counters, and the terminal
// error of the last finished run for the session.
// ---------------------------------------------------------------------------

interface LiveSessionState {
  /** Tab this download runs in. */
  tabId?: number;
  /** Coarse pipeline phase (uploading/assembling) reported to the UI. */
  phase?: string;
  /** The run's upload queue — polled at query time for live counters. */
  uploadQueue?: UploadQueue;
}

const liveSessionStates = new Map<string, LiveSessionState>();

/**
 * Terminal error of the last finished run, keyed by session. Deliberately
 * NOT cleared by markSessionNotLive (see its comment); cleared when the
 * session goes live again.
 */
const lastErrorBySession = new Map<string, string>();

/** Attach the run's upload queue so CHECK_DOWNLOAD_LIVE can read progress. */
export function setSessionUploadQueue(
  sessionId: string,
  uploadQueue: UploadQueue,
): void {
  const state = liveSessionStates.get(sessionId);
  if (state) state.uploadQueue = uploadQueue;
}

/** Update the coarse pipeline phase reported to the panel. */
export function setSessionPhase(sessionId: string, phase: string): void {
  const state = liveSessionStates.get(sessionId);
  if (state) state.phase = phase;
}

/** Record the terminal error of a failed run (persists past unmarking). */
export function setSessionLastError(sessionId: string, error: string): void {
  lastErrorBySession.set(sessionId, error);
}

/** Snapshot returned to the panel by CHECK_DOWNLOAD_LIVE (Round 9 Fix B). */
export interface DownloadLiveSnapshot {
  live: boolean;
  phase: string | null;
  completed: number | null;
  total: number | null;
  tabId: number | null;
  serverSessionId: string | null;
  lastError?: string;
}

/**
 * Build the CHECK_DOWNLOAD_LIVE answer for a session. Counters come from
 * the run's own upload queue at query time (no per-image pushes); a missing
 * queue or a counter failure degrades to nulls instead of throwing.
 */
export function getSessionDownloadSnapshot(
  sessionId?: string,
): DownloadLiveSnapshot {
  const live = isSessionLive(sessionId);
  const state = sessionId ? liveSessionStates.get(sessionId) : undefined;
  let completed: number | null = null;
  let total: number | null = null;
  if (live && state?.uploadQueue) {
    try {
      const progress = state.uploadQueue.getProgress();
      completed = progress.completedCount;
      total = progress.totalCount;
    } catch {
      // Counters unavailable — report nulls rather than throwing.
    }
  }
  const lastError = sessionId ? lastErrorBySession.get(sessionId) : undefined;
  return {
    live,
    phase: (live && state?.phase) || null,
    completed,
    total,
    tabId: state?.tabId ?? null,
    serverSessionId: sessionId ?? null,
    ...(lastError !== undefined ? { lastError } : {}),
  };
}

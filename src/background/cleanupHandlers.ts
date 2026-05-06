/**
 * Cleanup Handlers for WebsiteDownloader Extension
 * Provides automatic cleanup for service worker restarts and download completion
 */

import { memoryManager } from "../utils/MemoryManager";

import { readCheckpoint, clearCheckpoint } from "./download-checkpoint";
import { sendMessageToPanel, deleteServerSessionState } from "./message";
import { messageActions } from "../common/message";
import {
  abortActiveDownload,
  setDownloadAbortController,
  disconnectKeepalivePort,
  setTabDownloadComplete,
  removeDownloadsForTab,
} from "./download-state";
import { stopScraping, deleteScraper } from "./scraper-state";

// Type declarations for service worker events
declare global {
  interface ExtendableEvent extends Event {
    waitUntil(promise: Promise<any>): void;
  }

  interface ServiceWorkerGlobalScope {
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }
}

// Type assertion for self as ServiceWorkerGlobalScope
declare const self: ServiceWorkerGlobalScope;

/**
 * Initialize cleanup handlers for service worker lifecycle events
 */
export function initializeCleanupHandlers(): void {
  // Handle service worker startup
  if (typeof self !== "undefined" && "addEventListener" in self) {
    // Cleanup on service worker startup
    self.addEventListener("activate", (event: Event) => {
      // Type assertion to ExtendableEvent to access waitUntil
      (event as ExtendableEvent).waitUntil(performStartupCleanup());
    });

    // Handle service worker shutdown
    self.addEventListener("beforeunload", () => {
      performEmergencyCleanup();
    });

    // Handle extension updates/reloads
    chrome.runtime.onSuspend?.addListener(() => {
      performEmergencyCleanup();
    });

    chrome.runtime.onInstalled?.addListener(() => {
      performMaintenanceCleanup();
    });
  }

  // Setup periodic cleanup
  setupPeriodicCleanup();

  // Setup memory pressure monitoring
  setupMemoryPressureMonitoring();

  // Clean up per-tab state when a tab is closed
  setupTabLifecycleCleanup();
}

/**
 * Perform cleanup on service worker startup
 */
async function performStartupCleanup(): Promise<void> {
  try {
    // Check if there was an interrupted download (SW restart detection via chrome.storage.local)
    const { isDownloadInProgress } = await chrome.storage.local.get("isDownloadInProgress");
    if (isDownloadInProgress) {
      await handleInterruptedDownload();
    }

    // Perform memory cleanup
    await memoryManager.forceCleanup();
  } catch {
    // ignore
  }
}

/**
 * Handle interrupted downloads
 */
async function handleInterruptedDownload(): Promise<void> {
  try {
    // Read checkpoint before clearing it, so we can notify the sidepanel.
    const checkpoint = await readCheckpoint();

    // Reset download flag and active tab IDs (always, even if notification fails)
    await chrome.storage.local.set({ isDownloadInProgress: false });

    // Force cleanup to free any stuck resources
    await memoryManager.forceCleanup();

    // Notify sidepanel about the interrupted download.
    // If the panel isn't open, we keep the checkpoint so
    // CHECK_INTERRUPTED_DOWNLOAD can find it on panel open.
    if (checkpoint) {
      let panelNotified = false;
      try {
        await sendMessageToPanel(
          messageActions.DOWNLOAD_INTERRUPTED,
          checkpoint,
        );
        panelNotified = true;
      } catch {
        // Panel not connected — keep checkpoint for later discovery
      }

      if (panelNotified) {
        await clearCheckpoint();
      }
    } else {
      // No checkpoint but flag was set — clear any stale state
      await clearCheckpoint();
    }
  } catch {
    // ignore
  }
}

/**
 * Perform emergency cleanup on service worker shutdown
 */
function performEmergencyCleanup(): void {
  try {
    // Synchronous cleanup operations only
    memoryManager.shutdown();
  } catch {
    // ignore
  }
}

/**
 * Perform maintenance cleanup
 */
async function performMaintenanceCleanup(): Promise<void> {
  try {
    // Memory cleanup
    await memoryManager.forceCleanup();
  } catch {
    // ignore
  }
}

/**
 * Setup periodic cleanup to prevent memory accumulation
 */
function setupPeriodicCleanup(): void {
  const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

  setInterval(async () => {
    try {
      const memoryStats = memoryManager.getMemoryStats();

      // Only perform cleanup if memory pressure is medium or higher
      if (memoryStats.memoryPressureLevel !== "low") {
        await memoryManager.forceCleanup();
      }
    } catch {
      // ignore
    }
  }, CLEANUP_INTERVAL);
}

/**
 * Setup memory pressure monitoring and automatic responses
 */
function setupMemoryPressureMonitoring(): void {
  const MONITORING_INTERVAL = 30 * 1000; // 30 seconds

  setInterval(async () => {
    try {
      const memoryStats = memoryManager.getMemoryStats();

      // Auto-response to critical memory pressure
      if (memoryStats.memoryPressureLevel === "critical") {
        await handleCriticalMemoryPressure();
      }
    } catch {
      // ignore
    }
  }, MONITORING_INTERVAL);
}

/**
 * Handle critical memory pressure scenarios
 */
async function handleCriticalMemoryPressure(): Promise<void> {
  try {
    await memoryManager.forceCleanup();

    // Suggest garbage collection if available
    if (typeof gc !== "undefined") {
      gc();
    }
  } catch {
    // ignore
  }
}

/**
 * Clean up all per-tab state when a tab is closed.
 * Prevents memory leaks in the Maps used for multi-tab downloads.
 */
function setupTabLifecycleCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    // Abort any active download for this tab
    abortActiveDownload(tabId);

    // Clear per-tab maps
    setDownloadAbortController(null, tabId);
    disconnectKeepalivePort(tabId);
    stopScraping(tabId);
    deleteScraper(tabId);
    deleteServerSessionState(tabId);

    // Remove from active download tracking
    setTabDownloadComplete(tabId);
    removeDownloadsForTab(tabId);
  });
}

/**
 * Cleanup resources for a completed download
 */
export async function cleanupAfterDownload(_downloadId: string): Promise<void> {
  try {
    await memoryManager.forceCleanup();
  } catch {
    // ignore
  }
}

// Initialize cleanup handlers when this module is imported
if (typeof self !== "undefined") {
  setTimeout(() => {
    initializeCleanupHandlers();
  }, 1000);
}

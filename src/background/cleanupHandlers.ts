/**
 * Cleanup Handlers for WebsiteDownloader Extension
 * Provides automatic cleanup for service worker restarts and download completion
 */

import { memoryManager } from "../utils/MemoryManager";
import {
  cleanupOldBlobs,
  cleanupDownloadBlobs,
} from "../common/blobStorage";
import { getDownloadInProgress, setDownloadInProgress } from "./download";
import { DEFAULT_MEMORY_LIMITS } from "../utils/memoryLimits";

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
}

/**
 * Perform cleanup on service worker startup
 */
async function performStartupCleanup(): Promise<void> {
  try {
    // Check if there was an interrupted download
    const downloadInProgress = await getDownloadInProgress();
    if (downloadInProgress) {
      await handleInterruptedDownload();
    }

    // Clean up old blobs
    await cleanupOldBlobs();

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
    // Reset download flag
    await setDownloadInProgress(false);

    // Force cleanup to free any stuck resources
    await memoryManager.forceCleanup();

    // Clean up any orphaned blobs
    await cleanupOldBlobs(0); // Clean up all blobs since we can't track them
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
    // Clean up old blobs
    await cleanupOldBlobs();

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
        await cleanupOldBlobs();
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
    await cleanupOldBlobs(DEFAULT_MEMORY_LIMITS.MAX_BLOB_AGE / 4);

    // Suggest garbage collection if available
    if (typeof gc !== "undefined") {
      gc();
    }
  } catch {
    // ignore
  }
}

/**
 * Cleanup resources for a completed download
 */
export async function cleanupAfterDownload(downloadId: string): Promise<void> {
  try {
    await cleanupDownloadBlobs(downloadId);
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

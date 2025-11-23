/**
 * Cleanup Handlers for WebsiteDownloader Extension
 * Provides automatic cleanup for service worker restarts and download completion
 */

import { memoryManager } from "../utils/MemoryManager";
import {
  cleanupOldBlobs,
  cleanupDownloadBlobs,
  getBlobMemoryUsage,
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
  console.log("Initializing cleanup handlers...");

  // Handle service worker startup
  if (typeof self !== "undefined" && "addEventListener" in self) {
    // Cleanup on service worker startup
    self.addEventListener("activate", (event: Event) => {
      console.log("Service worker activated, performing cleanup...");
      // Type assertion to ExtendableEvent to access waitUntil
      (event as ExtendableEvent).waitUntil(performStartupCleanup());
    });

    // Handle service worker shutdown
    self.addEventListener("beforeunload", () => {
      console.log(
        "Service worker shutting down, performing emergency cleanup...",
      );
      performEmergencyCleanup();
    });

    // Handle extension updates/reloads
    chrome.runtime.onSuspend?.addListener(() => {
      console.log("Extension suspending, performing cleanup...");
      performEmergencyCleanup();
    });

    chrome.runtime.onInstalled?.addListener(() => {
      console.log("Extension installed/updated, performing cleanup...");
      // Chrome runtime installed event doesn't have waitUntil in all versions
      // So we run the cleanup without waiting
      performMaintenanceCleanup();
    });
  }

  // Setup periodic cleanup
  setupPeriodicCleanup();

  // Setup memory pressure monitoring
  setupMemoryPressureMonitoring();

  console.log("Cleanup handlers initialized");
}

/**
 * Perform cleanup on service worker startup
 */
async function performStartupCleanup(): Promise<void> {
  try {
    console.log("Performing startup cleanup...");

    // Check if there was an interrupted download
    const downloadInProgress = await getDownloadInProgress();
    if (downloadInProgress) {
      console.warn(
        "Detected interrupted download, performing emergency cleanup...",
      );
      await handleInterruptedDownload();
    }

    // Clean up old blobs
    await cleanupOldBlobs();

    // Perform memory cleanup
    await memoryManager.forceCleanup();

    // Log memory status
    const memoryStats = memoryManager.getMemoryStats();
    const blobStats = await getBlobMemoryUsage();

    console.log("Startup cleanup completed:", {
      memoryUsed: `${(memoryStats.totalMemoryUsed / 1024 / 1024).toFixed(1)}MB`,
      blobMemory: `${(blobStats.totalSize / 1024 / 1024).toFixed(1)}MB`,
      blobCount: blobStats.blobCount,
      memoryPressure: memoryStats.memoryPressureLevel,
    });
  } catch (error) {
    console.error("Error during startup cleanup:", error);
  }
}

/**
 * Handle interrupted downloads
 */
async function handleInterruptedDownload(): Promise<void> {
  try {
    console.log("Handling interrupted download...");

    // Reset download flag
    await setDownloadInProgress(false);

    // Force cleanup to free any stuck resources
    await memoryManager.forceCleanup();

    // Clean up any orphaned blobs
    await cleanupOldBlobs(0); // Clean up all blobs since we can't track them

    console.log("Interrupted download handled");
  } catch (error) {
    console.error("Error handling interrupted download:", error);
  }
}

/**
 * Perform emergency cleanup on service worker shutdown
 */
function performEmergencyCleanup(): void {
  try {
    console.log("Performing emergency cleanup...");

    // Synchronous cleanup operations only
    memoryManager.shutdown();

    console.log("Emergency cleanup completed");
  } catch (error) {
    console.error("Error during emergency cleanup:", error);
  }
}

/**
 * Perform maintenance cleanup
 */
async function performMaintenanceCleanup(): Promise<void> {
  try {
    console.log("Performing maintenance cleanup...");

    // Clean up old blobs
    await cleanupOldBlobs();

    // Memory cleanup
    await memoryManager.forceCleanup();

    console.log("Maintenance cleanup completed");
  } catch (error) {
    console.error("Error during maintenance cleanup:", error);
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
        console.log(
          "Performing periodic cleanup due to memory pressure:",
          memoryStats.memoryPressureLevel,
        );
        await cleanupOldBlobs();
      }
    } catch (error) {
      console.error("Error during periodic cleanup:", error);
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
      const blobStats = await getBlobMemoryUsage();

      // Log memory status in development or when memory pressure is high
      if (
        process.env.NODE_ENV === "development" ||
        memoryStats.memoryPressureLevel !== "low"
      ) {
        console.log("Memory Monitor:", {
          memoryUsed: `${(memoryStats.totalMemoryUsed / 1024 / 1024).toFixed(1)}MB`,
          memoryLimit: `${(memoryStats.totalMemoryLimit / 1024 / 1024).toFixed(1)}MB`,
          blobMemory: `${(blobStats.totalSize / 1024 / 1024).toFixed(1)}MB`,
          blobCount: blobStats.blobCount,
          pressure: memoryStats.memoryPressureLevel,
          activeDownloads: memoryStats.activeDownloads,
          queuedDownloads: memoryStats.queuedDownloads,
        });
      }

      // Auto-response to critical memory pressure
      if (memoryStats.memoryPressureLevel === "critical") {
        console.warn(
          "Critical memory pressure detected, performing emergency cleanup...",
        );
        await handleCriticalMemoryPressure();
      }
    } catch (error) {
      console.error("Error during memory pressure monitoring:", error);
    }
  }, MONITORING_INTERVAL);
}

/**
 * Handle critical memory pressure scenarios
 */
async function handleCriticalMemoryPressure(): Promise<void> {
  try {
    console.log("Handling critical memory pressure...");

    // Force cleanup of all possible resources
    await memoryManager.forceCleanup();

    // Clean up blobs more aggressively
    await cleanupOldBlobs(DEFAULT_MEMORY_LIMITS.MAX_BLOB_AGE / 4); // Clean up after 7.5 minutes instead of 30

    // Suggest garbage collection if available
    if (typeof gc !== "undefined") {
      gc();
    }

    console.log("Critical memory pressure handled");
  } catch (error) {
    console.error("Error handling critical memory pressure:", error);
  }
}

/**
 * Cleanup resources for a completed download
 */
export async function cleanupAfterDownload(downloadId: string): Promise<void> {
  try {
    console.log(`Cleaning up after download: ${downloadId}`);

    // Clean up download-specific blobs
    await cleanupDownloadBlobs(downloadId);

    // Memory cleanup
    await memoryManager.forceCleanup();

    console.log(`Cleanup completed for download: ${downloadId}`);
  } catch (error) {
    console.error(`Error during cleanup for download ${downloadId}:`, error);
  }
}

/**
 * Force cleanup of all memory resources (emergency function)
 */
export async function forceCleanupAllResources(): Promise<void> {
  try {
    console.log("Force cleaning all resources...");

    // Reset download state
    await setDownloadInProgress(false);

    // Clean up all blobs
    const { cleanupOldBlobs, forceCleanupAllBlobs } = await import(
      "../common/blobStorage"
    );
    await cleanupOldBlobs(0); // Clean up all old blobs
    await forceCleanupAllBlobs(); // Emergency blob cleanup

    // Force memory manager cleanup
    await memoryManager.forceCleanup();

    // Suggest garbage collection
    if (typeof gc !== "undefined") {
      gc();
    }

    console.log("All resources force cleaned");
  } catch (error) {
    console.error("Error during force cleanup:", error);
  }
}

/**
 * Get comprehensive memory and storage statistics
 */
export async function getComprehensiveStats(): Promise<{
  memoryStats: any;
  blobStats: any;
  recommendations: string[];
}> {
  try {
    const memoryStats = memoryManager.getMemoryStats();
    const blobStats = await getBlobMemoryUsage();

    const recommendations: string[] = [];

    // Generate recommendations based on current state
    if (memoryStats.memoryPressureLevel === "critical") {
      recommendations.push(
        "Critical memory pressure - consider restarting the browser",
      );
    } else if (memoryStats.memoryPressureLevel === "high") {
      recommendations.push("High memory usage - some features may be limited");
    }

    if (blobStats.blobCount > 100) {
      recommendations.push(
        "Large number of cached blobs - consider manual cleanup",
      );
    }

    if (blobStats.totalSize > 100 * 1024 * 1024) {
      // 100MB
      recommendations.push(
        "Large blob storage usage - automatic cleanup will be more aggressive",
      );
    }

    return {
      memoryStats,
      blobStats,
      recommendations,
    };
  } catch (error) {
    console.error("Error getting comprehensive stats:", error);
    return {
      memoryStats: {},
      blobStats: {},
      recommendations: ["Unable to retrieve statistics"],
    };
  }
}

// Initialize cleanup handlers when this module is imported
if (typeof self !== "undefined") {
  // Defer initialization to avoid blocking service worker startup
  setTimeout(() => {
    initializeCleanupHandlers();
  }, 1000);
}

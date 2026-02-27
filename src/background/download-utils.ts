
import { cleanupOldBlobs } from "../common/blobStorage";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";
import { downloadViaPanel, PanelUnavailableError } from "./panel-download";

/**
 * Format bytes to human readable format
 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}


/**
 * Perform memory cleanup at the start of download
 */
export async function performInitialCleanup(): Promise<void> {
  try {
    // Clean up old blobs
    await cleanupOldBlobs();

    // Get memory usage stats
    const memoryStats = memoryManager.getMemoryStats();

    // If memory pressure is already high, perform more aggressive cleanup
    if (
      memoryStats.memoryPressureLevel === MemoryPressureLevel.HIGH ||
      memoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL
    ) {
      await memoryManager.forceCleanup();
    }
  } catch {
    // ignore
  }
}

/**
 * Initiate the download process for the final blob.
 * 
 * Delegates to the side panel for blob URL creation, since service workers
 * cannot use URL.createObjectURL and data URLs cause Chrome to ignore the
 * filename parameter.
 */
export async function initiateDownload(
  blob: Blob,
  filename: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  tabId?: number
): Promise<void> {
  if (!blob || blob.size === 0) {
    const error = "No blob data available for download or blob is empty";
    sendMessage({ key: "error.noBlobData" });
    throw new Error(error);
  }

  try {
    // Delegate download to the side panel where URL.createObjectURL is available
    await downloadViaPanel(blob, filename, true, tabId);
    sendMessage({ key: "status.downloadStarted" });
  } catch (error) {
    if (error instanceof PanelUnavailableError) {
      // Side panel is not available — send a user-friendly error
      sendMessage({ key: "app.panelUnavailable" });
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown download error";
    sendMessage({ key: "error.downloadFailed", options: { error: errorMessage } });
    throw error;
  }
}

/**
 * Create ZIP and initiate download
 */
// createAndInitiateDownload removed. 
// Its functionality is now integrated directly into download-core.ts or handled by initiateDownload.


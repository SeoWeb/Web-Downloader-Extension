
import { cleanupOldBlobs } from "../common/blobStorage";
import { trackDownload } from "./download-state";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";

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
  } catch (error) {
    console.error("Error during initial cleanup:", error);
  }
}

/**
 * Initiate the download process for the final blob
 */
export async function initiateDownload(
  blob: Blob,
  filename: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  tabId?: number
): Promise<void> {
  if (!blob || blob.size === 0) {
    const error = "No blob data available for download or blob is empty";
    console.error(error);
    sendMessage({ key: "error.noBlobData" });
    throw new Error(error);
  }

  try {
    // For smaller files, we can often use data URLs or object URLs directly.
    // However, for larger files in service workers, object URLs might be limited.
    // But since we are now splitting files > 100MB into parts, the blob size passed here
    // should generally be manageable (100MB max per part if multi-part, or single small file).

    // Try object URL first as it's more efficient
    if (typeof URL.createObjectURL === "function") {
       const objectUrl = URL.createObjectURL(blob);
       
       try {
         const downloadId = await chrome.downloads.download({
           url: objectUrl,
           filename,
           saveAs: true,
           conflictAction: "uniquify",
         });
         
         // Store for cleanup
         const { downloads } = await chrome.storage.local.get("downloads");
         const downloadMap = downloads || {};
         downloadMap[downloadId] = objectUrl;
         await chrome.storage.local.set({ downloads: downloadMap });
         
         trackDownload(downloadId, filename, tabId);
       } catch (downloadError) {
         // Cleanup on failure
         URL.revokeObjectURL(objectUrl);
         throw downloadError;
       }
    } else {
       const dataUrl = await new Promise<string>((resolve, reject) => {
         const reader = new FileReader();
         reader.onload = () => resolve(reader.result as string);
         reader.onerror = () => reject(new Error("Failed to read blob as data URL"));
         reader.readAsDataURL(blob);
       });

       const downloadId = await chrome.downloads.download({
         url: dataUrl,
         filename,
         saveAs: true,
         conflictAction: "uniquify",
       });
       
       trackDownload(downloadId, filename, tabId);
    }
    sendMessage({ key: "status.downloadStarted" });
  } catch (error) {
    console.error("Critical error in initiateDownload:", error);
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


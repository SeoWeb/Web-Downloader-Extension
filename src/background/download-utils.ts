
import JSZip from "jszip";
import { saveBlob, cleanupOldBlobs, getBlobMemoryUsage } from "../common/blobStorage";
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

let creatingOffscreenDocument: Promise<void> | null = null;

export async function setupOffscreenDocument(path: string) {
  // Check if offscreen API is available (permission granted)
  if (!chrome.offscreen) {
    throw new Error("Offscreen permission is required for this operation");
  }

  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(path)],
  });

  if (existingContexts.length > 0) {
    return;
  }

  // Create offscreen document
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
  } else {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "To create Blob URLs for large downloads",
    });
    await creatingOffscreenDocument;
    creatingOffscreenDocument = null;
  }
}

/**
 * Perform memory cleanup at the start of download
 */
export async function performInitialCleanup(): Promise<void> {
  try {
    console.log("Performing initial memory cleanup...");

    // Clean up old blobs
    await cleanupOldBlobs();

    // Get memory usage stats
    const blobStats = await getBlobMemoryUsage();
    const memoryStats = memoryManager.getMemoryStats();

    console.log(`Memory stats before download:`, {
      blobMemory: formatBytes(blobStats.totalSize),
      blobCount: blobStats.blobCount,
      extensionMemory: formatBytes(memoryStats.totalMemoryUsed),
      memoryPressure: memoryStats.memoryPressureLevel,
    });

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
  console.log("Preparing to initiate download:", filename, "for tabId:", tabId);

  if (!blob || blob.size === 0) {
    throw new Error("No blob data available for download or blob is empty");
  }

  // Check if we're in a service worker
  const isServiceWorker =
    typeof self !== "undefined" &&
    self.constructor.name === "ServiceWorkerGlobalScope";

  if (isServiceWorker || typeof URL.createObjectURL !== "function") {
    // For service workers or when object URL is not available
    if (blob.size < 50 * 1024 * 1024) { // 50MB limit
      // Use data URL for smaller files
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
      
      // Track this download so completion is detected
      trackDownload(downloadId, filename, tabId);
    } else {
      // Use offscreen document for large files
      const key = `download-${Date.now()}`;
      await saveBlob(key, blob);

      await setupOffscreenDocument("offscreen.html");
      const response = await chrome.runtime.sendMessage({
        action: "createBlobUrl",
        key,
      });

      if (response.error) {
        throw new Error(response.error);
      }

      const downloadId = await chrome.downloads.download({
        url: response.url,
        filename,
        saveAs: true,
        conflictAction: "uniquify",
      });

      // Store for cleanup
      const { downloads } = await chrome.storage.local.get("downloads");
      const downloadMap = downloads || {};
      downloadMap[downloadId] = response.url;
      await chrome.storage.local.set({ downloads: downloadMap });
      
      trackDownload(downloadId, filename, tabId);
    }
  } else {
    // Regular download with object URL
    const objectUrl = URL.createObjectURL(blob);
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
  }

  console.log("Download initiated successfully");
  sendMessage({ key: "status.downloadStarted" });
}

/**
 * Create ZIP and initiate download
 */
export async function createAndInitiateDownload(
  zip: JSZip,
  zipFilename: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  tabId?: number
) {
  try {
    console.log("Creating final download package");
    sendMessage({ key: "status.creatingPackage" });

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    console.log("ZIP archive created");
    sendMessage({ key: "status.finalizingDownload" });

    if (!blob || blob.size === 0) {
      throw new Error("No blob data available for download or blob is empty");
    }

    await initiateDownload(blob, zipFilename, (msg) => {
        if (typeof msg === 'string') sendMessage(msg);
        else sendMessage(msg);
    }, tabId);
  } catch (error) {
    console.error("Error creating download package:", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to create download package";
    sendMessage(errorMessage);
    throw error;
  }
}

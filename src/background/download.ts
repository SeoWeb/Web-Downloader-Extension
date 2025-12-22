/// <reference types="chrome" />
import JSZip from "jszip";
import { getResources } from "./resources";
// import { messageActions } from "../common/message";
import {
  addIndexHtml,
  addContentText,
  addCssFiles,
  addJsFiles,
  addDocumentFiles,
  addImageFiles,
  addHtmlFiles,
} from "./fileHandlers";
import { convertToSingleFileHtml } from "./htmlUtils";
import {
  saveBlob,
  getBlobMemoryUsage,
  cleanupOldBlobs,
} from "../common/blobStorage";
import { memoryManager } from "../utils/MemoryManager";
import {
  DEFAULT_MEMORY_LIMITS,
  MEMORY_ERROR_MESSAGES,
  MemoryPressureLevel,
} from "../utils/memoryLimits";
import {
  initializeCleanupHandlers,
  cleanupAfterDownload,
} from "./cleanupHandlers";
import { finalizeIncrementalMerge, cleanupIncrementalMerges } from "./merge-html";

// Streaming imports
import { StreamingDownloader } from "../utils/StreamingDownloader";
import { createZipFromDownloads } from "../utils/chunkedZip";
import { createProgressPersistence } from "../utils/progressPersistence";
import { StreamingFetcher } from "../utils/streamingFetch";
import {
  StreamingDownload,
} from "../types/streaming";
import { FilterOptions } from "../types/filterTypes";

// Queue system imports
import { requestQueue } from "../utils/RequestQueue";

// Initialize cleanup handlers when this module loads
initializeCleanupHandlers();

// Initialize streaming infrastructure
const persistence = createProgressPersistence('indexeddb');
const streamingDownloader = new StreamingDownloader(persistence);
const streamingFetcher = new StreamingFetcher();

// Initialize queue system
// Set up queue event listeners for global monitoring
requestQueue.setEventListeners({
  onStart: (request) => {
    console.log(`Queue: Started processing ${request.resourceType} request for ${request.url}`);
  },
  onComplete: (result) => {
    console.log(`Queue: Completed ${result.requestId} request`);
  },
  onError: (request, error) => {
    console.error(`Queue: Failed ${request.resourceType} request for ${request.url}:`, error);
  },
  onRetry: (request, attempt) => {
    console.log(`Queue: Retrying ${request.resourceType} request for ${request.url}, attempt ${attempt}`);
  }
});

// Set up streaming event listeners
streamingDownloader.setEventListeners({
  onStart: (download) => {
    console.log(`Streaming download started: ${download.id} for ${download.url}`);
  },
  onProgress: (progress) => {
    console.log(`Streaming progress: ${progress.downloadId} - ${progress.completedChunks}/${progress.totalChunks} chunks (${formatBytes(progress.bytesDownloaded)}/${formatBytes(progress.totalBytes)})`);
  },
  onComplete: (download) => {
    console.log(`Streaming download completed: ${download.id}`);
  },
  onError: (download, error) => {
    console.error(`Streaming download failed: ${download.id}`, error);
  },
  onMemoryPressure: async (pressure) => {
    console.warn(`Memory pressure during streaming: ${pressure.level}`);

    if (pressure.shouldPause) {
      // Pause all active streaming downloads
      const activeDownloads = streamingDownloader.getActiveDownloads();
      for (const download of activeDownloads) {
        if (download.status === 'streaming') {
          await streamingDownloader.pauseDownload(download.id);
        }
      }
    }
  }
});

// download.ts

// Initialize memory management
const downloadId = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// Track active downloads for completion detection
// Map<downloadId, { tabId: number, filename: string }>
const activeDownloads = new Map<number, { tabId: number; filename: string }>();

// Keepalive port to prevent service worker termination during downloads
let keepalivePort: chrome.runtime.Port | null = null;

// Register cleanup callbacks with memory manager
memoryManager.registerCleanupCallback(async () => {
  console.log("Memory manager cleanup callback triggered");
  await cleanupOldBlobs();
  
  // Clear queue during cleanup
  await requestQueue.clear();
});

memoryManager.registerMemoryPressureCallback(async (level) => {
  console.log(`Memory pressure detected: ${level}`);

  if (level === MemoryPressureLevel.CRITICAL) {
    // Emergency cleanup
    await cleanupOldBlobs(DEFAULT_MEMORY_LIMITS.MAX_BLOB_AGE / 2); // Cleanup sooner
    console.warn("Emergency cleanup performed due to critical memory pressure");

    // Pause all streaming downloads during critical memory pressure
    const activeDownloads = streamingDownloader.getActiveDownloads();
    for (const download of activeDownloads) {
      if (download.status === 'streaming') {
        await streamingDownloader.pauseDownload(download.id);
      }
    }
    
    // Pause queue processing during critical memory pressure
    requestQueue.pause();
  } else if (level === MemoryPressureLevel.HIGH) {
    // Reduce queue concurrency during high memory pressure
    // Note: This would need to be implemented in RequestQueue if needed
    console.log("High memory pressure detected, queue will naturally reduce concurrency");
  } else if (level === MemoryPressureLevel.LOW) {
    // Resume normal queue operation
    requestQueue.resume();
  }
});

// Manage download state using chrome.storage.local to persist across service worker restarts
export const setDownloadInProgress = async (inProgress: boolean) => {
  await chrome.storage.local.set({ isDownloadInProgress: inProgress });
};

export const getDownloadInProgress = async (): Promise<boolean> => {
  const result = await chrome.storage.local.get("isDownloadInProgress");
  return result.isDownloadInProgress ?? false;
};

/**
 * Perform memory cleanup at the start of download
 */
const performInitialCleanup = async (): Promise<void> => {
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
};

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}

// Enhanced listener to track download completion and clean up object URLs
chrome.downloads.onChanged.addListener(async (delta) => {
  // Check if this download is being tracked
  const downloadInfo = activeDownloads.get(delta.id);
  
  // Handle download state changes
  if (delta.state) {
    if (delta.state.current === "complete") {
      
      if (downloadInfo) {
        // Store completion status in chrome.storage for the side panel to pick up
        try {
          await chrome.storage.local.set({
            downloadComplete: {
              downloadId: delta.id,
              filename: downloadInfo.filename,
              tabId: downloadInfo.tabId,
              timestamp: Date.now(),
            },
          });
          
          // Also try to send message in case side panel is still open
          try {
            await chrome.runtime.sendMessage({
              action: "DOWNLOAD_COMPLETE",
              downloadId: delta.id,
              filename: downloadInfo.filename,
              tabId: downloadInfo.tabId,
            });
          } catch (msgError) {
            // Side panel might be closed, that's ok - storage will handle it
            console.log(`Message send failed (expected if side panel closed):`, msgError);
          }
        } catch (error) {
          console.error(`Failed to store DOWNLOAD_COMPLETE status:`, error);
        }
        
        // Remove from tracking
        activeDownloads.delete(delta.id);
        
        // Disconnect keepalive if no more active downloads
        if (activeDownloads.size === 0 && keepalivePort) {
          keepalivePort.disconnect();
          keepalivePort = null;
        }
      }
    } else if (delta.state.current === "interrupted") {
      console.log(`Download interrupted: ${delta.id}`);
      
      if (downloadInfo) {
        // Get the download to check the error
        const [download] = await chrome.downloads.search({ id: delta.id });
        const error = download?.error;
        
        // Check if this was a user cancellation
        // User can cancel from save dialog (no error) or from chrome://downloads (USER_CANCELED error)
        const isCancelled = !error || error === "USER_CANCELED";
        
        if (isCancelled) {
          // Send cancellation message to the side panel
          try {
            await chrome.runtime.sendMessage({
              action: "DOWNLOAD_CANCELLED",
              downloadId: delta.id,
              tabId: downloadInfo.tabId,
            });
            console.log(`Sent DOWNLOAD_CANCELLED message for download ${delta.id}`);
          } catch (msgError) {
            console.error(`Failed to send DOWNLOAD_CANCELLED message:`, msgError);
          }
        } else {
          // It's an actual error, not a cancellation
          const errorMessage = error || "Download was interrupted";
          
          // Send failure message to the side panel
          try {
            await chrome.runtime.sendMessage({
              action: "DOWNLOAD_FAILED",
              downloadId: delta.id,
              error: errorMessage,
              tabId: downloadInfo.tabId,
            });
          } catch (msgError) {
            console.error(`Failed to send DOWNLOAD_FAILED message:`, msgError);
          }
        }
        
        // Remove from tracking
        activeDownloads.delete(delta.id);
        
        // Disconnect keepalive if no more active downloads
        if (activeDownloads.size === 0 && keepalivePort) {
          keepalivePort.disconnect();
          keepalivePort = null;
        }
      }
    }
  }
  
  // Original cleanup logic for object URLs
  if (delta.state && delta.state.current !== "inprogress") {
    const { downloads } = await chrome.storage.local.get("downloads");
    const downloadMap = downloads || {};

    if (downloadMap[delta.id]) {
      console.log(`Cleaning up object URL for download ${delta.id}`);
      const url = downloadMap[delta.id];

      // Only revoke object URLs, not data URLs or blob URLs
      if (url.startsWith("blob:") || url.startsWith("data:")) {
        try {
          if (typeof URL.revokeObjectURL === "function") {
            URL.revokeObjectURL(url);
          } else {
            // Send message to offscreen to revoke
            await setupOffscreenDocument("offscreen.html");
            chrome.runtime.sendMessage({ action: "revokeBlobUrl", url });
          }
        } catch (cleanupError) {
          console.warn(
            `Failed to revoke object URL for download ${delta.id}:`,
            cleanupError,
          );
        }
      }

      delete downloadMap[delta.id];
      await chrome.storage.local.set({ downloads: downloadMap });
    }
  }
});

let creatingOffscreenDocument: Promise<void> | null = null;

async function setupOffscreenDocument(path: string) {
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
 * Enhanced download function with streaming support for large files
 */
export async function downloadResources(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string) => void,
  assemblyJobId?: string, // Optional job ID for incremental assembly
) {
  console.log("Starting downloadResources for URL:", tabUrl);

  if (!tabUrl) {
    console.error("No tab URL provided");
    sendMessage("Error: No URL provided for download");
    return;
  }

  // Prevent concurrent downloads
  if (await getDownloadInProgress()) {
    console.warn("Download already in progress, rejecting new request");
    sendMessage("A download is already in progress. Please wait.");
    return;
  }

  // Initial memory check and cleanup
  const initialMemoryStats = memoryManager.getMemoryStats();
  if (initialMemoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL) {
    console.error("Cannot start download - critical memory pressure");
    sendMessage(
      "Cannot start download due to critical memory pressure. Please try again later.",
    );
    return;
  }

  await setDownloadInProgress(true);

  try {
    // Perform initial cleanup
    await performInitialCleanup();

    // Execute the download within a try-catch-finally block
    await executeDownload(html, tabUrl, downloadOptions, sendMessage, assemblyJobId);
  } catch (error) {
    console.error("Download failed:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    
    // Categorize error for better user feedback
    let userFriendlyMessage = `Download failed: ${errorMessage}`;
    let isMemoryError = false;

    if (
      errorMessage.includes("memory") ||
      errorMessage.includes("size") ||
      errorMessage.includes("limit") ||
      errorMessage.includes("quota")
    ) {
      isMemoryError = true;
      userFriendlyMessage = "Download failed due to memory limits. Attempting cleanup...";
    } else if (
      errorMessage.includes("network") ||
      errorMessage.includes("fetch") ||
      errorMessage.includes("connection") ||
      errorMessage.includes("offline")
    ) {
      userFriendlyMessage = "Download failed due to network issues. Please check your connection.";
    }

    sendMessage(userFriendlyMessage);

    // If it's a memory-related error, perform cleanup
    if (isMemoryError) {
      console.log("Memory-related error detected, performing cleanup...");
      await memoryManager.forceCleanup();
      sendMessage(
        "Memory cleanup performed. Please try downloading again with fewer options selected.",
      );
    }
  } finally {
    // Always reset the flag when done and cleanup
    await setDownloadInProgress(false);

    // Cleanup download-specific resources
    try {
      await cleanupAfterDownload(downloadId);
      
      // Clear the queue after download completion
      await requestQueue.clear();
      console.log("Queue cleared after download completion");
    } catch (cleanupError) {
      console.error("Error during final cleanup:", cleanupError);
    }

    // Final memory stats
    const finalMemoryStats = memoryManager.getMemoryStats();
    console.log("Download process completed. Final memory stats:", {
      memoryUsed: formatBytes(finalMemoryStats.totalMemoryUsed),
      memoryPressure: finalMemoryStats.memoryPressureLevel,
      completedDownloads: finalMemoryStats.completedDownloads,
      queueStats: requestQueue.getStats(),
    });

    console.log("Download process completed");
  }
}

async function executeDownload(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string) => void,
  assemblyJobId?: string,
) {
  // Check network connectivity
  try {
    const online = await new Promise<boolean>((resolve) => {
      // Simple connectivity check
      fetch("https://www.google.com/favicon.ico", {
        method: "HEAD",
        mode: "no-cors",
      })
        .then(() => resolve(true))
        .catch(() => resolve(false));

      // Fallback timeout
      setTimeout(() => resolve(false), 5000);
    });

    if (!online) {
      sendMessage(
        "No internet connection - cannot download external resources",
      );
      console.warn("No internet connection detected");
      // Continue with basic HTML download only
      if (!downloadOptions.downloadHTML && !downloadOptions.singleFile) {
        sendMessage(
          "Please enable HTML download or single file mode for offline use",
        );
        return;
      }
    }
  } catch (error) {
    console.warn("Network check failed, continuing with download:", error);
    // Continue with download but warn about potential issues
    sendMessage("Network connectivity check failed - continuing with download");
  }

  const zip = new JSZip();
  const data = getResources(html);
  console.log("Extracted resources:", data);

  const u = new URL(tabUrl || "");

  // Generate a safe filename from the URL
  const hostname = u.hostname.replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "");
  const path = u.pathname
    .split("/")
    .slice(1)
    .filter((part) => part.length > 0) // Remove empty parts
    .join("-")
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-"); // Replace invalid characters with hyphens

  // Limit filename length and ensure it's not empty
  const safePath =
    path.length > 100 ? path.substring(0, 100) : path || "webpage";
  const timestamp = Date.now();

  let zipFilename: string;
  if (downloadOptions.singleFile) {
    zipFilename = `${hostname}-${safePath}-${timestamp}.html`;
  } else {
    zipFilename = `${hostname}-${safePath}-${timestamp}.zip`;
  }

  console.log("Generated filename:", zipFilename);

  if (downloadOptions.downloadHTML) {
    console.log("Creating index.html");
    sendMessage("Creating index.html");

    // Handle incremental assembly if job ID is provided
    if (assemblyJobId) {
      try {
        console.log(`Finalizing incremental HTML assembly job: ${assemblyJobId}`);
        const finalizeResult = finalizeIncrementalMerge(assemblyJobId);
        
        if (!finalizeResult.success) {
          console.error(`Failed to finalize incremental assembly: ${finalizeResult.error}`);
          sendMessage(`Error: ${finalizeResult.error}`);
          
          // Fall back to regular HTML processing
          await processRegularHtml(html, zip, tabUrl, sendMessage);
        } else {
          // Use the assembled HTML
          const finalHtml = finalizeResult.html;
          if (finalHtml) {
            await addIndexHtml(finalHtml, zip, tabUrl);
            console.log("Incrementally assembled HTML added to ZIP");
            sendMessage("HTML content assembled and added to download");
          } else if (finalizeResult.blob) {
            // Handle blob case for large files
            console.log("Using blob for large HTML content");
            await addIndexHtmlFromBlob(finalizeResult.blob, zip);
            sendMessage("Large HTML content processed and added to download");
          }
        }
      } catch (error) {
        console.error("Error during incremental HTML assembly:", error);
        sendMessage("Error during HTML assembly, falling back to regular processing");
        await processRegularHtml(html, zip, tabUrl, sendMessage);
      }
    } else {
      // Regular HTML processing
      await processRegularHtml(html, zip, tabUrl, sendMessage);
    }
  }

  if (downloadOptions.downloadAssets) {
    console.log("Downloading assets");
    sendMessage("Downloading CSS files");
    try {
      await addCssFiles(data.css, zip, tabUrl, sendMessage, downloadId);
      console.log("CSS files downloaded:", data.css.length);
      sendMessage("CSS files downloaded");
    } catch (error) {
      console.error("Error downloading CSS files:", error);
      sendMessage("Error downloading CSS files - some may be missing");
    }

    sendMessage("Downloading JS files");
    try {
      await addJsFiles(data.js, zip, tabUrl, sendMessage, downloadId);
      console.log("JS files downloaded:", data.js.length);
      sendMessage("JS files downloaded");
    } catch (error) {
      console.error("Error downloading JS files:", error);
      sendMessage("Error downloading JS files - some may be missing");
    }
  }

  if (downloadOptions.downloadDocuments) {
    console.log("Downloading documents");
    sendMessage("Downloading document files");
    await addDocumentFiles(
      data.documents,
      zip,
      tabUrl,
      sendMessage,
      downloadId,
    );
    console.log("Documents downloaded:", data.documents.length);
    sendMessage("Document files downloaded");
  }

  if (downloadOptions.downloadImages) {
    console.log("Downloading images");
    sendMessage("Downloading images");
    await addImageFiles(data.images, zip, tabUrl, sendMessage, downloadId);
    console.log("Images downloaded:", data.images.length);
    sendMessage("Images downloaded");
  }

  if (downloadOptions.downloadLinks) {
    console.log("Downloading linked HTML files");
    sendMessage("Downloading linked html files");
    await addHtmlFiles(data.links, zip, tabUrl, sendMessage, downloadId);
    console.log("Linked HTML files downloaded:", data.links.length);
    sendMessage("Linked html files downloaded");
  }

  if (downloadOptions.downloadContentAsText) {
    console.log("Downloading content as text");
    sendMessage("Downloading content as text");
    await addContentText(data.text, zip);
    console.log("Content text downloaded");
    sendMessage("Content as text downloaded");
  }

  try {
    console.log("Creating final download package");
    let blob: Blob;

    if (downloadOptions.singleFile) {
      sendMessage("Creating index.html");
      const singleFileHtml = await convertToSingleFileHtml(html, tabUrl);
      blob = new Blob([singleFileHtml], { type: "text/html;charset=UTF-8" });
      zipFilename = zipFilename.replace(".zip", ".html");
      console.log("Single HTML file created");
    } else {
      console.log("Generating ZIP archive");
      blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      console.log("ZIP archive created");
    }

    console.log("Preparing download");
    if (!blob || blob.size === 0) {
      throw new Error("No blob data available for download or blob is empty");
    }

    /**
     * Helper function to track a download and keep service worker alive
     */
    const trackDownload = (downloadId: number, filename: string, tabId?: number) => {
      // Store download info for tracking
      activeDownloads.set(downloadId, {
        tabId: tabId || 0,
        filename,
      });
      
      // Create keepalive connection if not already exists
      if (!keepalivePort) {
        keepalivePort = chrome.runtime.connect({ name: "keepalive" });
        console.log("Created keepalive port to prevent service worker termination");
      }
      
      console.log(`Tracking download ${downloadId}: ${filename}`);
    };

    // Use a more reliable approach - create object URL instead of FileReader
    const downloadWithRetry = async (attempt = 1): Promise<void> => {
      try {
        console.log(`Preparing download (attempt ${attempt}):`, zipFilename);

        // In service workers, we need to use data URLs directly since URL.createObjectURL is not available
        // Check if we're in a service worker context
        // We use a loose check to avoid TypeScript errors with ServiceWorkerGlobalScope
        const isServiceWorker =
          typeof self !== "undefined" &&
          self.constructor.name === "ServiceWorkerGlobalScope";

        if (isServiceWorker || typeof URL.createObjectURL !== "function") {
          console.log(
            "Running in service worker context or URL.createObjectURL not available, using data URL directly",
          );

          // For service workers, we must use data URLs directly
          if (blob.size < 50 * 1024 * 1024) {
            // 50MB limit for data URLs in Chrome
            // Convert blob to data URL using FileReader
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () =>
                reject(new Error("Failed to read blob as data URL"));
              reader.readAsDataURL(blob);
            });

            // Use data URL directly with chrome.downloads.download
            const dataUrlDownloadId = await new Promise<number>(
              (resolve, reject) => {
                chrome.downloads.download(
                  {
                    url: dataUrl,
                    filename: zipFilename,
                    saveAs: true,
                    conflictAction: "uniquify",
                  },
                  (downloadId) => {
                    if (chrome.runtime.lastError) {
                      reject(new Error(chrome.runtime.lastError.message));
                    } else if (downloadId === undefined) {
                      reject(
                        new Error("Download failed: No download ID assigned."),
                      );
                    } else {
                      resolve(downloadId);
                    }
                  },
                );
              },
            );

            console.log(
              "Download started with data URL, ID:",
              dataUrlDownloadId,
            );
            
            // Track the download for completion monitoring
            trackDownload(dataUrlDownloadId, zipFilename);
            
            sendMessage("Download started successfully");
            return;
          } else {
            console.log(
              `Blob too large for data URL (${formatBytes(blob.size)} bytes). Using offscreen document.`,
            );

            // Memory check for large blob creation
            if (!memoryManager.checkMemoryAvailability(blob.size)) {
              const errorMsg = MEMORY_ERROR_MESSAGES.MEMORY_LIMIT_EXCEEDED(
                memoryManager.getMemoryStats().totalMemoryUsed + blob.size,
                DEFAULT_MEMORY_LIMITS.MAX_TOTAL_MEMORY_USAGE,
              );
              sendMessage(errorMsg);
              throw new Error(errorMsg);
            }

            // Check if offscreen permission is available
            if (!chrome.offscreen) {
              const errorMsg =
                "Download too large (>50MB). Please enable 'Offscreen' permission in the extension settings to download large files.";
              sendMessage(errorMsg);
              throw new Error(errorMsg);
            }

            sendMessage(
              "Large file detected, using advanced download method...",
            );

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

            const objectUrl = response.url;
            console.log("Created object URL via offscreen:", objectUrl);

            const offscreenDownloadId = await new Promise<number>(
              (resolve, reject) => {
                chrome.downloads.download(
                  {
                    url: objectUrl,
                    filename: zipFilename,
                    saveAs: true,
                    conflictAction: "uniquify",
                  },
                  (downloadId) => {
                    if (chrome.runtime.lastError) {
                      reject(new Error(chrome.runtime.lastError.message));
                    } else if (downloadId === undefined) {
                      reject(
                        new Error("Download failed: No download ID assigned."),
                      );
                    } else {
                      resolve(downloadId);
                    }
                  },
                );
              },
            );

            console.log(
              "Download started successfully via offscreen, ID:",
              offscreenDownloadId,
            );
            
            // Track the download for completion monitoring
            trackDownload(offscreenDownloadId, zipFilename);
            
            sendMessage("Download started successfully");

            // Store the mapping of download ID to object URL for later cleanup
            const { downloads } = await chrome.storage.local.get("downloads");
            const downloadMap = downloads || {};
            downloadMap[offscreenDownloadId] = objectUrl;
            await chrome.storage.local.set({ downloads: downloadMap });
            return;
          }
        } else {
          // In non-service worker contexts, we can use object URLs
          console.log("Using object URL for download");
          const objectUrl = URL.createObjectURL(blob);
          console.log(
            "Created object URL:",
            objectUrl.substring(0, 50) + "...",
          );

          const objectUrlDownloadId = await new Promise<number>(
            (resolve, reject) => {
              chrome.downloads.download(
                {
                  url: objectUrl,
                  filename: zipFilename,
                  saveAs: true,
                  conflictAction: "uniquify",
                },
                (downloadId) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                  } else if (downloadId === undefined) {
                    reject(
                      new Error("Download failed: No download ID assigned."),
                    );
                  } else {
                    resolve(downloadId);
                  }
                },
              );
            },
          );

          console.log(
            "Download started successfully, ID:",
            objectUrlDownloadId,
          );
          
          // Track the download for completion monitoring
          trackDownload(objectUrlDownloadId, zipFilename);
          
          sendMessage("Download started successfully");

          // Store the mapping of download ID to object URL for later cleanup
          const { downloads } = await chrome.storage.local.get("downloads");
          const downloadMap = downloads || {};
          downloadMap[objectUrlDownloadId] = objectUrl;
          await chrome.storage.local.set({ downloads: downloadMap });
        }
      } catch (error) {
        console.warn(`Download attempt ${attempt} failed:`, error);

        if (attempt >= 3) {
          throw new Error(
            `Failed to download after 3 attempts: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Exponential backoff for retries
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise((res) => setTimeout(res, delay));
        return downloadWithRetry(attempt + 1);
      }
    };

    await downloadWithRetry();
  } catch (error) {
    console.error("Error creating download package:", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to create download package";
    sendMessage(errorMessage);
    throw error; // Re-throw to allow calling code to handle the error
  }

  return data.links;
}

/**
 * Enhanced streaming download function for large files
 */
export async function downloadResourcesWithStreaming(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string) => void,
) {
  console.log("Starting streaming downloadResources for URL:", tabUrl);

  if (!tabUrl) {
    console.error("No tab URL provided");
    sendMessage("Error: No URL provided for download");
    return;
  }

  // Check if any resources are large enough to benefit from streaming
  const data = getResources(html);
  const hasLargeFiles = await checkForLargeFiles(data);

  if (!hasLargeFiles) {
    // Fall back to regular download for small files
    console.log("No large files detected, using regular download");
    return downloadResources(html, tabUrl, downloadOptions, sendMessage);
  }

  // Prevent concurrent downloads
  if (await getDownloadInProgress()) {
    console.warn("Download already in progress, rejecting new request");
    sendMessage("A download is already in progress. Please wait.");
    return;
  }

  await setDownloadInProgress(true);

  try {
    await executeStreamingDownload(html, tabUrl, downloadOptions, sendMessage, data);
  } catch (error) {
    console.error("Streaming download failed:", error);

    // Fall back to regular download on streaming failure
    sendMessage("Streaming download failed, falling back to regular download...");
    try {
      await downloadResources(html, tabUrl, downloadOptions, sendMessage);
    } catch (fallbackError) {
      console.error("Fallback download also failed:", fallbackError);
      sendMessage(`Download failed: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}`);
    }
  } finally {
    await setDownloadInProgress(false);
  }
}

/**
 * Execute streaming download with chunked processing
 */
async function executeStreamingDownload(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string) => void,
  data: ReturnType<typeof getResources>
) {
  const u = new URL(tabUrl || "");

  // Generate a safe filename
  const hostname = u.hostname.replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "");
  const path = u.pathname
    .split("/")
    .slice(1)
    .filter((part) => part.length > 0)
    .join("-")
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-");

  const safePath = path.length > 100 ? path.substring(0, 100) : path || "webpage";
  const timestamp = Date.now();

  const zipFilename = `${hostname}-${safePath}-${timestamp}.zip`;
  console.log("Generated streaming filename:", zipFilename);

  // Create streaming downloads for all resources
  const streamingDownloads: Array<{ download: StreamingDownload; path: string }> = [];

  // Download HTML
  if (downloadOptions.downloadHTML) {
    sendMessage("Processing HTML content");

    // For HTML, we'll handle it directly since it's usually not too large
    streamingDownloads.push({
      download: {
        id: `html-${timestamp}`,
        url: tabUrl,
        totalSize: html.length,
        downloadedSize: html.length,
        progress: 1.0,
        chunks: [],
        status: 'completed',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: Date.now(),
        resumable: false,
        activeChunks: 0,
        chunkSize: 0,
        mimeType: 'text/html',
        filename: 'index.html',
      },
      path: 'index.html'
    });
  }

  // Download CSS files with streaming
  if (downloadOptions.downloadAssets && data.css.length > 0) {
    sendMessage(`Processing ${data.css.length} CSS files`);

    for (let i = 0; i < data.css.length; i++) {
      const cssUrl = data.css[i];
      if (!cssUrl) continue;

      try {
        const shouldStream = streamingDownloader.shouldUseStreaming(cssUrl);

        if (shouldStream) {
          sendMessage(`Starting streaming download for CSS: ${i + 1}/${data.css.length}`);
          const download = await streamingDownloader.startDownload(cssUrl, {
            chunkSize: 512 * 1024, // 512KB chunks for CSS
            maxParallelChunks: 2,
          });

          const filename = new URL(cssUrl, tabUrl).pathname.split("/").pop() || `style-${i}.css`;
          streamingDownloads.push({
            download,
            path: `styles/${filename}`,
          });
        } else {
          // Use regular download for small CSS files
          // This will be handled by the regular file handlers
        }
      } catch (error) {
        console.error(`Error streaming CSS ${cssUrl}:`, error);
        // Fall back to regular download
      }
    }
  }

  // Download JavaScript files with streaming
  if (downloadOptions.downloadAssets && data.js.length > 0) {
    sendMessage(`Processing ${data.js.length} JS files`);

    for (let i = 0; i < data.js.length; i++) {
      const jsUrl = data.js[i];
      if (!jsUrl) continue;

      try {
        const shouldStream = streamingDownloader.shouldUseStreaming(jsUrl);

        if (shouldStream) {
          sendMessage(`Starting streaming download for JS: ${i + 1}/${data.js.length}`);
          const download = await streamingDownloader.startDownload(jsUrl, {
            chunkSize: 512 * 1024, // 512KB chunks for JS
            maxParallelChunks: 2,
          });

          const filename = new URL(jsUrl, tabUrl).pathname.split("/").pop() || `script-${i}.js`;
          streamingDownloads.push({
            download,
            path: `scripts/${filename}`,
          });
        }
      } catch (error) {
        console.error(`Error streaming JS ${jsUrl}:`, error);
      }
    }
  }

  // Download images with streaming
  if (downloadOptions.downloadImages && data.images.length > 0) {
    sendMessage(`Processing ${data.images.length} images`);

    for (let i = 0; i < data.images.length; i++) {
      const imageUrl = data.images[i];
      if (!imageUrl || imageUrl.startsWith("data:")) continue;

      try {
        const shouldStream = streamingDownloader.shouldUseStreaming(imageUrl);

        if (shouldStream) {
          sendMessage(`Starting streaming download for image: ${i + 1}/${data.images.length}`);
          const download = await streamingDownloader.startDownload(imageUrl, {
            chunkSize: 1024 * 1024, // 1MB chunks for images
            maxParallelChunks: 3,
          });

          const filename = new URL(imageUrl, tabUrl).pathname.split("/").pop() || `image-${i}`;
          streamingDownloads.push({
            download,
            path: `images/${filename}`,
          });
        }
      } catch (error) {
        console.error(`Error streaming image ${imageUrl}:`, error);
      }
    }
  }

  // Wait for all streaming downloads to complete
  if (streamingDownloads.length > 0) {
    sendMessage(`Waiting for ${streamingDownloads.length} streaming downloads to complete...`);

    const completionPromises = streamingDownloads.map(async ({ download }) => {
      while (download.status !== 'completed' && download.status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 100));
        // Update progress
        const progress = streamingDownloader.getProgress(download.id);
        if (progress && progress.status === 'streaming') {
          const progressPercentage = progress.totalBytes > 0
            ? (progress.bytesDownloaded / progress.totalBytes) * 100
            : 0;
          sendMessage(`Streaming progress: ${progress.completedChunks}/${progress.totalChunks} chunks (${Math.round(progressPercentage)}%)`);
        }
      }

      if (download.status === 'failed') {
        throw new Error(`Streaming download failed for ${download.url}: ${download.error}`);
      }

      return download;
    });

    await Promise.all(completionPromises);
    sendMessage("All streaming downloads completed");
  }

  // Add regular file downloads for non-streamed content
  if (downloadOptions.downloadAssets) {
    await addRegularFiles(data, downloadOptions, tabUrl, sendMessage, downloadId);
  }

  // Create ZIP with chunked processing
  sendMessage("Creating ZIP file with streaming content...");

  try {
    const zipBlob = await createZipFromDownloads(streamingDownloads, {
      progressive: true,
      compressionLevel: 6,
      maxMemoryUsage: 50 * 1024 * 1024, // 50MB limit
      enableStreaming: true,
    });

    await initiateDownload(zipBlob, zipFilename, sendMessage);
    sendMessage("Streaming download completed successfully");

  } catch (error) {
    console.error("Error creating streaming ZIP:", error);
    throw error;
  }
}

/**
 * Check if any files are large enough to benefit from streaming
 */
async function checkForLargeFiles(data: ReturnType<typeof getResources>): Promise<boolean> {
  const checkThreshold = 5 * 1024 * 1024; // 5MB threshold
  const allUrls = [...data.css, ...data.js, ...data.images, ...data.documents];

  for (const url of allUrls) {
    if (!url || url.startsWith("data:")) continue;

    try {
      const metadata = await streamingFetcher.getMetadata(url, { chunkTimeout: 5000 });
      if (metadata.size > checkThreshold) {
        console.log(`Large file detected: ${url} (${formatBytes(metadata.size)})`);
        return true;
      }
    } catch (error) {
      // If we can't determine size, conservatively assume it might be large
      const largeFileExtensions = ['.zip', '.rar', '.7z', '.tar', '.gz', '.mp4', '.avi', '.mov', '.mkv'];
      if (largeFileExtensions.some(ext => url.toLowerCase().includes(ext))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Add regular file downloads for content not handled by streaming
 */
async function addRegularFiles(
  data: ReturnType<typeof getResources>,
  downloadOptions: FilterOptions,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId: string
) {
  const zip = new JSZip();

  if (downloadOptions.downloadAssets) {
    // Add CSS files that weren't streamed
    if (data.css.length > 0) {
      await addCssFiles(data.css, zip, tabUrl, sendMessage, downloadId);
    }

    // Add JS files that weren't streamed
    if (data.js.length > 0) {
      await addJsFiles(data.js, zip, tabUrl, sendMessage, downloadId);
    }
  }

  if (downloadOptions.downloadDocuments) {
    await addDocumentFiles(data.documents, zip, tabUrl, sendMessage, downloadId);
  }

  if (downloadOptions.downloadImages) {
    await addImageFiles(data.images, zip, tabUrl, sendMessage, downloadId);
  }

  if (downloadOptions.downloadLinks) {
    await addHtmlFiles(data.links, zip, tabUrl, sendMessage, downloadId);
  }

  if (downloadOptions.downloadContentAsText) {
    await addContentText(data.text, zip);
  }
}

/**
 * Initiate the download process for the final blob
 */
async function initiateDownload(
  blob: Blob,
  filename: string,
  sendMessage: (message: string) => void
): Promise<void> {
  console.log("Preparing to initiate download:", filename);

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

      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: true,
        conflictAction: "uniquify",
      });
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
  }

  console.log("Download initiated successfully");
  sendMessage("Download started successfully");
}

/**
 * Process regular HTML content (non-incremental)
 */
async function processRegularHtml(
  html: string,
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  // Check HTML size before processing
  if (html.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
    console.warn(`HTML content too large: ${formatBytes(html.length)}`);
    sendMessage("HTML content is too large, may be truncated");
  }

  await addIndexHtml(html, zip, tabUrl);
  console.log("index.html created");
  sendMessage("Index.html created");
}

/**
 * Add HTML content from blob to ZIP (for large files)
 */
async function addIndexHtmlFromBlob(
  htmlBlob: Blob,
  zip: JSZip,
) {
  try {
    // Convert blob to array buffer and then to string
    const arrayBuffer = await htmlBlob.arrayBuffer();
    const htmlContent = new TextDecoder('utf-8').decode(arrayBuffer);
    
    // Add to ZIP
    zip.file("index.html", htmlContent, {
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    
    console.log(`Added HTML from blob (${formatBytes(htmlBlob.size)}) to ZIP`);
  } catch (error) {
    console.error("Error adding HTML blob to ZIP:", error);
    throw new Error(`Failed to process HTML content: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Enhanced download function with incremental HTML assembly support
 */
export async function downloadResourcesWithIncrementalAssembly(
  assemblyJobId: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string) => void,
) {
  console.log(`Starting download with incremental assembly for job: ${assemblyJobId}`);

  if (!tabUrl) {
    console.error("No tab URL provided");
    sendMessage("Error: No URL provided for download");
    return;
  }

  // Prevent concurrent downloads
  if (await getDownloadInProgress()) {
    console.warn("Download already in progress, rejecting new request");
    sendMessage("A download is already in progress. Please wait.");
    return;
  }

  // Initial memory check
  const initialMemoryStats = memoryManager.getMemoryStats();
  if (initialMemoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL) {
    console.error("Cannot start download - critical memory pressure");
    sendMessage(
      "Cannot start download due to critical memory pressure. Please try again later.",
    );
    return;
  }

  await setDownloadInProgress(true);

  try {
    // Perform initial cleanup
    await performInitialCleanup();

    // Execute download with incremental assembly
    await executeDownloadWithIncrementalAssembly(assemblyJobId, tabUrl, downloadOptions, sendMessage);
  } catch (error) {
    console.error("Incremental download failed:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    sendMessage(`Download failed: ${errorMessage}`);

    // If it's a memory-related error, perform cleanup
    if (
      errorMessage.includes("memory") ||
      errorMessage.includes("size") ||
      errorMessage.includes("limit")
    ) {
      console.log("Memory-related error detected, performing cleanup...");
      await memoryManager.forceCleanup();
      sendMessage(
        "Memory cleanup performed due to download failure. Please try again.",
      );
    }
  } finally {
    // Always reset the flag when done and cleanup
    await setDownloadInProgress(false);

    // Cleanup download-specific resources
    try {
      await cleanupAfterDownload(downloadId);
    } catch (cleanupError) {
      console.error("Error during final cleanup:", cleanupError);
    }

    // Clean up incremental assembly jobs
    try {
      const cleanedJobs = cleanupIncrementalMerges();
      if (cleanedJobs > 0) {
        console.log(`Cleaned up ${cleanedJobs} old assembly jobs`);
      }
    } catch (cleanupError) {
      console.error("Error during assembly job cleanup:", cleanupError);
    }

    // Final memory stats
    const finalMemoryStats = memoryManager.getMemoryStats();
    console.log("Incremental download process completed. Final memory stats:", {
      memoryUsed: formatBytes(finalMemoryStats.totalMemoryUsed),
      memoryPressure: finalMemoryStats.memoryPressureLevel,
      completedDownloads: finalMemoryStats.completedDownloads,
    });

    console.log("Incremental download process completed");
  }
}

/**
 * Execute download with incremental HTML assembly
 */
async function executeDownloadWithIncrementalAssembly(
  assemblyJobId: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string) => void,
) {
  const zip = new JSZip();
  
  // Generate filename
  const u = new URL(tabUrl || "");
  const hostname = u.hostname.replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "");
  const path = u.pathname
    .split("/")
    .slice(1)
    .filter((part) => part.length > 0)
    .join("-")
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-");

  const safePath = path.length > 100 ? path.substring(0, 100) : path || "webpage";
  const timestamp = Date.now();
  const zipFilename = `${hostname}-${safePath}-${timestamp}.zip`;

  console.log("Generated incremental filename:", zipFilename);

  // Process HTML with incremental assembly
  if (downloadOptions.downloadHTML) {
    console.log("Processing HTML with incremental assembly");
    sendMessage("Processing HTML content with incremental assembly");

    // Finalize the incremental assembly job
    const finalizeResult = finalizeIncrementalMerge(assemblyJobId);
    
    if (!finalizeResult.success) {
      throw new Error(`Failed to finalize HTML assembly: ${finalizeResult.error}`);
    }

    if (finalizeResult.html) {
      await addIndexHtml(finalizeResult.html, zip, tabUrl);
      console.log("Incrementally assembled HTML added to ZIP");
      sendMessage("HTML content assembled and added to download");
    } else if (finalizeResult.blob) {
      await addIndexHtmlFromBlob(finalizeResult.blob, zip);
      console.log("Large HTML content processed and added to download");
      sendMessage("Large HTML content processed and added to download");
    }
  }

  // Process other resources (same as regular download)
  const data = getResources(""); // Empty HTML since we're using incremental assembly
  
  if (downloadOptions.downloadAssets) {
    // Process CSS and JS files
    await processAssets(data, zip, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadDocuments) {
    await processDocuments(data.documents, zip, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadImages) {
    await processImages(data.images, zip, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadLinks) {
    await processLinks(data.links, zip, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadContentAsText) {
    await addContentText(data.text, zip);
  }

  // Create and initiate download
  await createAndInitiateDownload(zip, zipFilename, sendMessage);
}

/**
 * Process CSS and JS assets
 */
async function processAssets(
  data: { css: string[]; js: string[] },
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (data.css.length > 0) {
    sendMessage("Downloading CSS files");
    try {
      await addCssFiles(data.css, zip, tabUrl, sendMessage, downloadId);
      console.log("CSS files downloaded:", data.css.length);
      sendMessage("CSS files downloaded");
    } catch (error) {
      console.error("Error downloading CSS files:", error);
      sendMessage("Error downloading CSS files - some may be missing");
    }
  }

  if (data.js.length > 0) {
    sendMessage("Downloading JS files");
    try {
      await addJsFiles(data.js, zip, tabUrl, sendMessage, downloadId);
      console.log("JS files downloaded:", data.js.length);
      sendMessage("JS files downloaded");
    } catch (error) {
      console.error("Error downloading JS files:", error);
      sendMessage("Error downloading JS files - some may be missing");
    }
  }
}

/**
 * Process document files
 */
async function processDocuments(
  documents: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (documents.length > 0) {
    sendMessage("Downloading document files");
    await addDocumentFiles(documents, zip, tabUrl, sendMessage, downloadId);
    console.log("Documents downloaded:", documents.length);
    sendMessage("Document files downloaded");
  }
}

/**
 * Process image files
 */
async function processImages(
  images: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (images.length > 0) {
    sendMessage("Downloading images");
    await addImageFiles(images, zip, tabUrl, sendMessage, downloadId);
    console.log("Images downloaded:", images.length);
    sendMessage("Images downloaded");
  }
}

/**
 * Process linked HTML files
 */
async function processLinks(
  links: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (links.length > 0) {
    sendMessage("Downloading linked HTML files");
    await addHtmlFiles(links, zip, tabUrl, sendMessage, downloadId);
    console.log("Linked HTML files downloaded:", links.length);
    sendMessage("Linked HTML files downloaded");
  }
}

/**
 * Create ZIP and initiate download
 */
async function createAndInitiateDownload(
  zip: JSZip,
  zipFilename: string,
  sendMessage: (message: string) => void
) {
  try {
    console.log("Creating final download package");
    sendMessage("Creating final download package");

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    console.log("ZIP archive created");
    sendMessage("Finalizing download");

    if (!blob || blob.size === 0) {
      throw new Error("No blob data available for download or blob is empty");
    }

    await initiateDownload(blob, zipFilename, sendMessage);
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

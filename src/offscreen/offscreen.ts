import { getBlob, deleteBlob } from "../common/blobStorage";

/// <reference types="chrome" />

// Streaming-related imports
import { StreamingDownloader } from "../utils/StreamingDownloader";
import { createProgressPersistence } from "../utils/progressPersistence";
import { StreamingDownload } from "../types/streaming";

// Initialize streaming infrastructure in offscreen document
const persistence = createProgressPersistence('memory');
const streamingDownloader = new StreamingDownloader(persistence);

// Track active blob URLs for cleanup
const activeBlobUrls = new Set<string>();
const activeDownloads = new Map<string, StreamingDownload>();

// Memory monitoring
let memoryMonitorInterval: number | null = null;

chrome.runtime.onMessage.addListener(
  (
    message: any,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ) => {
    if (message.action === "createBlobUrl") {
      handleCreateBlobUrl(message.key)
        .then(sendResponse)
        .catch((error) => {
          console.error("Error creating blob URL:", error);
          sendResponse({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true; // Keep channel open for async response
    } else if (message.action === "revokeBlobUrl") {
      handleRevokeBlobUrl(message.url);
      sendResponse({ success: true });
    } else if (message.action === "createStreamingBlobUrl") {
      handleCreateStreamingBlobUrl(message.downloadId)
        .then(sendResponse)
        .catch((error) => {
          console.error("Error creating streaming blob URL:", error);
          sendResponse({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    } else if (message.action === "startStreamingDownload") {
      handleStartStreamingDownload(message.url, message.options)
        .then(sendResponse)
        .catch((error) => {
          console.error("Error starting streaming download:", error);
          sendResponse({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    } else if (message.action === "getStreamingProgress") {
      const progress = streamingDownloader.getProgress(message.downloadId);
      sendResponse({ progress });
    } else if (message.action === "pauseStreamingDownload") {
      handlePauseStreamingDownload(message.downloadId)
        .then(sendResponse)
        .catch((error) => {
          console.error("Error pausing streaming download:", error);
          sendResponse({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    } else if (message.action === "resumeStreamingDownload") {
      handleResumeStreamingDownload(message.downloadId)
        .then(sendResponse)
        .catch((error) => {
          console.error("Error resuming streaming download:", error);
          sendResponse({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    } else if (message.action === "cancelStreamingDownload") {
      handleCancelStreamingDownload(message.downloadId)
        .then(sendResponse)
        .catch((error) => {
          console.error("Error canceling streaming download:", error);
          sendResponse({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    } else if (message.action === "getMemoryUsage") {
      const memoryUsage = getMemoryUsage();
      sendResponse({ memoryUsage });
    }
  },
);

// Start memory monitoring
startMemoryMonitoring();

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  cleanup();
});

/**
 * Enhanced blob URL creation with streaming support
 */
async function handleCreateBlobUrl(key: string) {
  try {
    const blob = await getBlob(key);
    const url = URL.createObjectURL(blob);

    // Track the URL for cleanup
    activeBlobUrls.add(url);

    // Delete from storage to free up space
    await deleteBlob(key);

    console.log(`Created blob URL for key: ${key}`);
    return { url };
  } catch (error) {
    console.error("Failed to create blob URL:", error);
    throw error;
  }
}

/**
 * Create blob URL from completed streaming download
 */
async function handleCreateStreamingBlobUrl(downloadId: string) {
  try {
    const downloads = streamingDownloader.getActiveDownloads();
    const download = downloads.find(d => d.id === downloadId);
    if (!download || download.status !== 'completed') {
      throw new Error(`Download not completed: ${downloadId}`);
    }

    // Combine all chunks into a single blob
    const chunks = download.chunks
      .filter((chunk: any) => chunk.downloaded && chunk.data)
      .sort((a: any, b: any) => a.index - b.index);

    if (chunks.length === 0) {
      throw new Error(`No valid chunks found for download: ${downloadId}`);
    }

    // Create blob from all chunks
    const blobParts: ArrayBuffer[] = [];
    for (const chunk of chunks) {
      if (chunk.data) {
        const arrayBuffer = chunk.data instanceof ArrayBuffer
          ? chunk.data
          : await (chunk.data as Blob).arrayBuffer();
        blobParts.push(arrayBuffer);
      }
    }

    const combinedBlob = new Blob(blobParts, { type: download.mimeType });
    const url = URL.createObjectURL(combinedBlob);

    // Track the URL for cleanup
    activeBlobUrls.add(url);

    console.log(`Created blob URL for streaming download: ${downloadId}`);
    return { url };
  } catch (error) {
    console.error("Failed to create streaming blob URL:", error);
    throw error;
  }
}

/**
 * Start a streaming download in offscreen document
 */
async function handleStartStreamingDownload(url: string, options: any) {
  try {
    const download = await streamingDownloader.startDownload(url, options);
    activeDownloads.set(download.id, download);

    console.log(`Started streaming download: ${download.id}`);
    return { downloadId: download.id };
  } catch (error) {
    console.error("Failed to start streaming download:", error);
    throw error;
  }
}

/**
 * Pause a streaming download
 */
async function handlePauseStreamingDownload(downloadId: string) {
  try {
    await streamingDownloader.pauseDownload(downloadId);
    console.log(`Paused streaming download: ${downloadId}`);
    return { success: true };
  } catch (error) {
    console.error("Failed to pause streaming download:", error);
    throw error;
  }
}

/**
 * Resume a streaming download
 */
async function handleResumeStreamingDownload(downloadId: string) {
  try {
    await streamingDownloader.resumeDownload(downloadId);
    console.log(`Resumed streaming download: ${downloadId}`);
    return { success: true };
  } catch (error) {
    console.error("Failed to resume streaming download:", error);
    throw error;
  }
}

/**
 * Cancel a streaming download
 */
async function handleCancelStreamingDownload(downloadId: string) {
  try {
    await streamingDownloader.cancelDownload(downloadId);
    activeDownloads.delete(downloadId);
    console.log(`Canceled streaming download: ${downloadId}`);
    return { success: true };
  } catch (error) {
    console.error("Failed to cancel streaming download:", error);
    throw error;
  }
}

/**
 * Get current memory usage information
 */
function getMemoryUsage() {
  // Type assertion for performance.memory which is a Chrome-specific API
  const perfMemory = (performance as any).memory;
  if (perfMemory) {
    return {
      used: perfMemory.usedJSHeapSize,
      total: perfMemory.totalJSHeapSize,
      limit: perfMemory.jsHeapSizeLimit,
      percentage: (perfMemory.usedJSHeapSize / perfMemory.jsHeapSizeLimit) * 100,
      activeBlobUrls: activeBlobUrls.size,
      activeDownloads: activeDownloads.size,
    };
  }
  return {
    used: 0,
    total: 0,
    limit: 0,
    percentage: 0,
    activeBlobUrls: activeBlobUrls.size,
    activeDownloads: activeDownloads.size,
  };
}

/**
 * Start memory monitoring
 */
function startMemoryMonitoring() {
  memoryMonitorInterval = window.setInterval(() => {
    const memoryUsage = getMemoryUsage();

    // Log memory usage for debugging
    console.log('Offscreen memory usage:', {
      used: formatBytes(memoryUsage.used),
      percentage: memoryUsage.percentage.toFixed(1) + '%',
      activeUrls: memoryUsage.activeBlobUrls,
      activeDownloads: memoryUsage.activeDownloads,
    });

    // Perform cleanup if memory usage is high
    if (memoryUsage.percentage > 80) {
      console.warn('High memory usage detected, performing cleanup');
      performCleanup();
    }
  }, 30000); // Check every 30 seconds
}

/**
 * Perform cleanup operations
 */
function performCleanup() {
  // Revoke old blob URLs
  if (activeBlobUrls.size > 10) {
    const urlsToRevoke = Array.from(activeBlobUrls).slice(0, 5);
    urlsToRevoke.forEach(url => {
      URL.revokeObjectURL(url);
      activeBlobUrls.delete(url);
    });
    console.log(`Revoked ${urlsToRevoke.length} old blob URLs`);
  }

  // Force garbage collection if available
  if (window.gc) {
    window.gc();
    console.log('Forced garbage collection');
  }
}

/**
 * Revoke blob URL
 */
function handleRevokeBlobUrl(url: string) {
  URL.revokeObjectURL(url);
  activeBlobUrls.delete(url);
}

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

/**
 * Cleanup resources
 */
function cleanup() {
  // Clear memory monitoring
  if (memoryMonitorInterval) {
    clearInterval(memoryMonitorInterval);
    memoryMonitorInterval = null;
  }

  // Revoke all blob URLs
  activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
  activeBlobUrls.clear();

  // Cancel all active downloads
  activeDownloads.forEach(async (download) => {
    try {
      await streamingDownloader.cancelDownload(download.id);
    } catch (error) {
      console.error(`Failed to cancel download ${download.id} during cleanup:`, error);
    }
  });
  activeDownloads.clear();

  // Destroy streaming downloader
  streamingDownloader.destroy();

  console.log('Offscreen document cleanup completed');
}


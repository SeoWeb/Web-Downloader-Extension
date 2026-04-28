
/// <reference types="chrome" />
import { initializeCleanupHandlers } from "./cleanupHandlers";
import { streamingDownloader } from "./download-services";
import { requestQueue } from "../utils/RequestQueue";
import { cleanupOldBlobs } from "../common/blobStorage";
import { memoryManager } from "../utils/MemoryManager";
import { DEFAULT_MEMORY_LIMITS, MemoryPressureLevel } from "../utils/memoryLimits";
import { initializeDownloadListener } from "./download-listener";
import { downloadResources } from "./download-core";
import { downloadResourcesWithStreaming } from "./download-streaming";
import { downloadResourcesWithIncrementalAssembly } from "./download-incremental";
import { setTabDownloadActive, setTabDownloadComplete, isAnyDownloadInProgress, isTabDownloadInProgress } from "./download-state";

// Initialize cleanup handlers when this module loads
initializeCleanupHandlers();

// Initialize listeners
initializeDownloadListener();

// Initialize queue system
// Set up queue event listeners for global monitoring
requestQueue.setEventListeners({
  onStart: () => {
    // console .log(`Queue: Started processing ${request.resourceType} request for ${request.url}`);
  },
  onComplete: () => {
    // console .log(`Queue: Completed ${result.requestId} request`);
  },
  onError: () => {
    // console .error(`Queue: Failed ${request.resourceType} request for ${request.url}:`, error);
  },
  onRetry: () => {
    // console .log(`Queue: Retrying ${request.resourceType} request for ${request.url}, attempt ${attempt}`);
  }
});

// Set up streaming event listeners
streamingDownloader.setEventListeners({
  onStart: () => {
    // console .log(`Streaming download started: ${download.id} for ${download.url}`);
  },
  onProgress: () => {
    // console .log(`Streaming progress: ${progress.downloadId} - ${progress.completedChunks}/${progress.totalChunks} chunks (${formatBytes(progress.bytesDownloaded)}/${formatBytes(progress.totalBytes)})`);
  },
  onComplete: () => {
    // console .log(`Streaming download completed: ${download.id}`);
  },
  onError: () => {
    // console .error(`Streaming download failed: ${download.id}`, error);
  },
  onMemoryPressure: async (pressure) => {
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

// Register cleanup callbacks with memory manager
memoryManager.registerCleanupCallback(async () => {
  await cleanupOldBlobs();
  
  // Clear queue during cleanup
  await requestQueue.clear();
});

memoryManager.registerMemoryPressureCallback(async (level) => {
  // console .log(`Memory pressure detected: ${level}`);

  if (level === MemoryPressureLevel.CRITICAL) {
    // Emergency cleanup
    await cleanupOldBlobs(DEFAULT_MEMORY_LIMITS.MAX_BLOB_AGE / 2); // Cleanup sooner
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
  } else if (level === MemoryPressureLevel.LOW) {
    // Resume normal queue operation
    requestQueue.resume();
  }
});

export {
  downloadResources,
  downloadResourcesWithStreaming,
  downloadResourcesWithIncrementalAssembly,
  setTabDownloadActive,
  setTabDownloadComplete,
  isAnyDownloadInProgress,
  isTabDownloadInProgress,
};

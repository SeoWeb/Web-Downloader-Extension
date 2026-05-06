
/// <reference types="chrome" />
import { initializeCleanupHandlers } from "./cleanupHandlers";
import { requestQueue } from "../utils/RequestQueue";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";
import { initializeDownloadListener } from "./download-listener";
import { downloadResources } from "./download-core";
import { setTabDownloadActive, setTabDownloadComplete, isAnyDownloadInProgress, isTabDownloadInProgress } from "./download-state";

// Initialize cleanup handlers when this module loads
initializeCleanupHandlers();

// Initialize listeners
initializeDownloadListener();

// Initialize queue system
requestQueue.setEventListeners({
  onStart: () => {
  },
  onComplete: () => {
  },
  onError: () => {
  },
  onRetry: () => {
  }
});

// Register cleanup callbacks with memory manager
memoryManager.registerCleanupCallback(async () => {
  // Clear queue during cleanup
  await requestQueue.clear();
});

memoryManager.registerMemoryPressureCallback(async (level) => {
  if (level === MemoryPressureLevel.CRITICAL) {
    // Pause queue processing during critical memory pressure
    requestQueue.pause();
  } else if (level === MemoryPressureLevel.LOW) {
    // Resume normal queue operation
    requestQueue.resume();
  }
});

export {
  downloadResources,
  setTabDownloadActive,
  setTabDownloadComplete,
  isAnyDownloadInProgress,
  isTabDownloadInProgress,
};

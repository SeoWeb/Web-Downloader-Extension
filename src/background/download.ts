/// <reference types="chrome" />
import { requestQueue } from "../utils/RequestQueue";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";
import { initializeDownloadListener } from "./download-listener";
import { downloadResources } from "./download-core";
import {
  setTabDownloadActive,
  setTabDownloadComplete,
  isAnyDownloadInProgress,
  isTabDownloadInProgress,
} from "./download-state";

// NOTE (task 4.3): cleanup handlers self-initialize on module import
// (cleanupHandlers.ts) — the explicit call that used to live here created a
// duplicate-registration path and has been removed.

// Initialize listeners
initializeDownloadListener();

// Initialize queue system
requestQueue.setEventListeners({
  onStart: () => {},
  onComplete: () => {},
  onError: () => {},
  onRetry: () => {},
});

// Register cleanup callbacks with memory manager
memoryManager.registerCleanupCallback(async () => {
  // The full queue clear aborts in-flight fetches and drops the queued
  // requests of EVERY download sharing the queue — it is only safe when no
  // download is active (concurrent-downloads spec). During critical memory
  // pressure with active downloads, the pause/resume callback below throttles
  // instead; the last finishing download's teardown performs the full clear.
  if (!isAnyDownloadInProgress()) {
    await requestQueue.clear();
  }
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

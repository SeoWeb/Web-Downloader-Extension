/**
 * Cleanup Handlers for WebsiteDownloader Extension
 * Provides automatic cleanup for service worker restarts and download completion
 *
 * Lifecycle (D9 / task 4.3): all periodic work uses `chrome.alarms` —
 * setInterval/setTimeout timers do not survive MV3 service-worker suspension.
 * Listeners are registered exactly once per service-worker lifetime via the
 * `handlersInitialized` guard (the module self-initializes on import; the
 * former duplicate setTimeout(1000) registration path was removed).
 */

import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";

import { readAllCheckpoints, clearCheckpoint } from "./download-checkpoint";
import { sendMessageToPanel, deleteServerSessionState } from "./message";
import { messageActions } from "../common/message";
import {
  abortActiveDownload,
  setDownloadAbortController,
  disconnectKeepalivePort,
  setTabDownloadComplete,
  removeDownloadsForTab,
} from "./download-state";
import { stopScraping, deleteScraper } from "./scraper-state";

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

// ---------------------------------------------------------------------------
// Alarm names — re-created on every service worker start (module import)
// ---------------------------------------------------------------------------

const PERIODIC_CLEANUP_ALARM = "pagepocket-periodic-cleanup";
const MEMORY_MONITOR_ALARM = "pagepocket-memory-monitor";

const PERIODIC_CLEANUP_MINUTES = 10; // every 10 minutes
const MEMORY_MONITOR_MINUTES = 1; // alarms clamp sub-minute periods to 1 min

/** Guard: every chrome.* listener below is registered exactly once per SW
 *  lifetime, no matter how many times initializeCleanupHandlers is called
 *  (module import + download.ts). */
let handlersInitialized = false;

/** Last pressure level seen by the monitor — extra cleanup runs only on
 *  real transitions (e.g. HIGH → CRITICAL), not on every alarm tick. */
let lastMonitoredLevel: MemoryPressureLevel | null = null;

/**
 * Initialize cleanup handlers for service worker lifecycle events.
 * Idempotent — safe to call multiple times; registration happens once.
 */
export function initializeCleanupHandlers(): void {
  if (handlersInitialized) {
    return;
  }
  handlersInitialized = true;

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

  // (Task 4.3) Periodic cleanup + memory monitoring via chrome.alarms —
  // survives service worker termination, unlike setInterval.
  setupPeriodicCleanupAlarm();
  setupMemoryPressureMonitorAlarm();
  setupAlarmHandler();

  // Clean up per-tab state when a tab is closed
  setupTabLifecycleCleanup();
}

/**
 * (Task 4.3) Single chrome.alarms.onAlarm handler dispatching both alarms.
 * Registered once; the alarms themselves are (re-)created on every SW start
 * by the setup functions below — chrome.alarms.create with a known name
 * overwrites, so re-registration on SW restart is idempotent.
 */
function setupAlarmHandler(): void {
  if (!chrome.alarms) {
    console.warn(
      "[Cleanup] chrome.alarms unavailable — add the 'alarms' permission to the manifest",
    );
    return;
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    // Fire-and-forget — cleanup must never keep the SW alive or throw
    runAlarmCleanup(alarm.name).catch(() => {
      // ignore
    });
  });
}

/** Dispatch an alarm to its cleanup routine. Exported for tests. */
export async function runAlarmCleanup(alarmName: string): Promise<void> {
  try {
    if (alarmName === PERIODIC_CLEANUP_ALARM) {
      await runPeriodicCleanup();
    } else if (alarmName === MEMORY_MONITOR_ALARM) {
      await runMemoryPressureCheck();
    }
  } catch {
    // ignore — cleanup is best-effort
  }
}

/**
 * Re-create the periodic cleanup alarm. Called on every SW start (module
 * import) so the alarm survives worker termination.
 */
function setupPeriodicCleanupAlarm(): void {
  if (!chrome.alarms) {
    console.warn(
      "[Cleanup] chrome.alarms unavailable — periodic cleanup disabled",
    );
    return;
  }

  chrome.alarms.create(PERIODIC_CLEANUP_ALARM, {
    periodInMinutes: PERIODIC_CLEANUP_MINUTES,
  });
}

/**
 * Re-create the memory-pressure monitor alarm (fires every minute).
 */
function setupMemoryPressureMonitorAlarm(): void {
  if (!chrome.alarms) {
    console.warn(
      "[Cleanup] chrome.alarms unavailable — memory monitoring disabled",
    );
    return;
  }

  chrome.alarms.create(MEMORY_MONITOR_ALARM, {
    periodInMinutes: MEMORY_MONITOR_MINUTES,
  });
}

/**
 * Periodic cleanup body — only frees memory when pressure is MEDIUM or
 * higher. Comparisons use the NUMERIC enum rank (task 4.3): the previous
 * `!== "low"` string comparison never matched the numeric enum, so this
 * cleanup never ran.
 */
async function runPeriodicCleanup(): Promise<void> {
  try {
    const memoryStats = memoryManager.getMemoryStats();

    // Only perform cleanup if memory pressure is medium or higher
    if (memoryStats.memoryPressureLevel >= MemoryPressureLevel.MEDIUM) {
      await memoryManager.forceCleanup();
    }
  } catch {
    // ignore
  }
}

/**
 * Memory pressure monitor body — the CRITICAL handler actually fires now
 * (the previous `=== "critical"` string comparison was runtime-broken
 * against the numeric enum). Extra cleanup runs only on a real transition
 * into CRITICAL; sustained pressure is handled by the periodic cleanup.
 */
async function runMemoryPressureCheck(): Promise<void> {
  try {
    const memoryStats = memoryManager.getMemoryStats();
    const level = memoryStats.memoryPressureLevel;
    const previous = lastMonitoredLevel;
    lastMonitoredLevel = level;

    // Auto-response on transition into critical memory pressure
    if (
      level >= MemoryPressureLevel.CRITICAL &&
      (previous === null || previous < MemoryPressureLevel.CRITICAL)
    ) {
      await handleCriticalMemoryPressure();
    }
  } catch {
    // ignore
  }
}

/**
 * Perform cleanup on service worker startup
 */
async function performStartupCleanup(): Promise<void> {
  try {
    // Check if there was an interrupted download (SW restart detection via chrome.storage.local)
    const { isDownloadInProgress } = await chrome.storage.local.get(
      "isDownloadInProgress",
    );
    if (isDownloadInProgress) {
      await handleInterruptedDownload();
    }

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
    // (D4) Read ALL per-download checkpoints before clearing any, so every
    // interrupted download (including concurrent ones) is detected. Each is
    // offered to the panel; only checkpoints successfully delivered are
    // cleared — the rest stay discoverable via CHECK_INTERRUPTED_DOWNLOAD
    // when the panel opens.
    const checkpoints = await readAllCheckpoints();

    // Reset download flag and active tab IDs (always, even if notification fails)
    await chrome.storage.local.set({ isDownloadInProgress: false });

    // Force cleanup to free any stuck resources
    await memoryManager.forceCleanup();

    if (checkpoints.length > 0) {
      for (const checkpoint of checkpoints) {
        let panelNotified = false;
        try {
          await sendMessageToPanel(
            messageActions.DOWNLOAD_INTERRUPTED,
            checkpoint,
          );
          panelNotified = true;
        } catch {
          // Panel not connected — keep this checkpoint for later discovery
        }

        if (panelNotified) {
          await clearCheckpoint(checkpoint.serverSessionId);
        }
      }
    } else {
      // No checkpoint but flag was set — clear any stale state
      // (Fix D.2: explicit all-flag for the legacy global wipe)
      await clearCheckpoint(undefined, { all: true });
    }
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
    // Memory cleanup
    await memoryManager.forceCleanup();
  } catch {
    // ignore
  }
}

/**
 * Handle critical memory pressure scenarios
 */
async function handleCriticalMemoryPressure(): Promise<void> {
  try {
    await memoryManager.forceCleanup();

    // Suggest garbage collection if available
    if (typeof gc !== "undefined") {
      gc();
    }
  } catch {
    // ignore
  }
}

/**
 * Clean up all per-tab state when a tab is closed.
 * Prevents memory leaks in the Maps used for multi-tab downloads.
 */
function setupTabLifecycleCleanup(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    // Abort any active download for this tab
    abortActiveDownload(tabId);

    // Clear per-tab maps
    setDownloadAbortController(null, tabId);
    disconnectKeepalivePort(tabId);
    stopScraping(tabId);
    deleteScraper(tabId);
    deleteServerSessionState(tabId);

    // Remove from active download tracking
    setTabDownloadComplete(tabId);
    removeDownloadsForTab(tabId);
  });
}

/**
 * Cleanup resources for a completed download
 */
export async function cleanupAfterDownload(_downloadId: string): Promise<void> {
  try {
    await memoryManager.forceCleanup();
  } catch {
    // ignore
  }
}

// (Task 4.3) Initialize once at module import — every service worker start
// re-runs this module, which both registers the listeners (guarded, once per
// lifetime) and re-creates the cleanup alarms. The former duplicate
// setTimeout(1000) registration path was removed.
if (typeof self !== "undefined") {
  initializeCleanupHandlers();
}

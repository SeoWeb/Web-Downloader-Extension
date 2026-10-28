/**
 * Tests for warm-restart startup cleanup (D5 / tasks 4.1–4.4).
 *
 * Verifies:
 * - A warm wake (module init WITHOUT an `activate` event) runs startup
 *   cleanup: the `isDownloadInProgress` flag is cleared and interrupted-
 *   download checkpoints are processed. Previously the cleanup was wired to
 *   `activate` only, which MV3 does not re-fire on warm kills + wakes.
 * - A connected panel is pushed `DOWNLOAD_INTERRUPTED` and the delivered
 *   checkpoint is cleared; with no panel connected the checkpoint is
 *   retained for the later `CHECK_INTERRUPTED_DOWNLOAD` discovery.
 * - Cleanup runs at most once per worker lifetime: re-firing init or
 *   dispatching additional lifecycle events never re-runs it.
 * - The `activate` path (install/update) is preserved and routes through the
 *   same once-per-lifetime guard (no double run).
 * - The no-op path (nothing interrupted) stays cheap: a single
 *   chrome.storage.local.get, no writes, no pushes.
 * - The wake-time run is fire-and-forget: a failing cleanup never produces
 *   an unhandled rejection and never throws out of module init.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Chrome + self mock — must exist BEFORE cleanupHandlers is imported
// ---------------------------------------------------------------------------

const registry = vi.hoisted(() => {
  const mocks = {
    storageLocalGet: vi.fn(),
    storageLocalSet: vi.fn(),
    alarmsCreate: vi.fn(),
    alarmsOnAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
    tabsOnRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    runtimeOnSuspend: { addListener: vi.fn() },
    runtimeOnInstalled: { addListener: vi.fn() },
    sendMessageToPanel: vi.fn(),
    readAllCheckpoints: vi.fn(),
    clearCheckpoint: vi.fn(),
    forceCleanup: vi.fn(),
    shutdown: vi.fn(),
    getMemoryStats: vi.fn(),
  };

  // Capture service-worker lifecycle listeners registered via
  // self.addEventListener. Vitest's worker globals may lack
  // addEventListener (cleanupHandlers' `"addEventListener" in self` guard
  // would then skip registration entirely), so provide one when missing and
  // delegate otherwise.
  const selfListeners: Record<string, Array<(event: any) => void>> = {};
  const g = globalThis as any;
  g.self = g.self ?? {};
  const originalAddEventListener = g.self.addEventListener;
  if (typeof originalAddEventListener === "function") {
    g.self.addEventListener = (type: string, listener: any, options?: any) => {
      (selfListeners[type] ??= []).push(listener);
      originalAddEventListener.call(g.self, type, listener, options);
    };
  } else {
    g.self.addEventListener = (type: string, listener: any) => {
      (selfListeners[type] ??= []).push(listener);
    };
  }

  // Augment chrome BEFORE the module under test is imported: vitest defines
  // `self` in workers, so cleanupHandlers auto-initializes at import time —
  // which is exactly the warm-wake path under test.
  g.chrome = {
    ...(g.chrome ?? {}),
    storage: {
      ...(g.chrome?.storage ?? {}),
      local: {
        get: mocks.storageLocalGet,
        set: mocks.storageLocalSet,
      },
    },
    alarms: {
      create: mocks.alarmsCreate,
      onAlarm: mocks.alarmsOnAlarm,
    },
    tabs: {
      onRemoved: mocks.tabsOnRemoved,
    },
    runtime: {
      onSuspend: mocks.runtimeOnSuspend,
      onInstalled: mocks.runtimeOnInstalled,
    },
  };

  return { ...mocks, selfListeners };
});

// ---------------------------------------------------------------------------
// Module mocks (stable instances across vi.resetModules, keep the graph light)
// ---------------------------------------------------------------------------

vi.mock("../../src/background/message", () => ({
  sendMessageToPanel: registry.sendMessageToPanel,
  deleteServerSessionState: vi.fn(),
}));

vi.mock("../../src/background/download-checkpoint", () => ({
  readCheckpoint: vi.fn().mockResolvedValue(null),
  readAllCheckpoints: registry.readAllCheckpoints,
  clearCheckpoint: registry.clearCheckpoint,
}));

vi.mock("../../src/background/download-state", () => ({
  abortActiveDownload: vi.fn(),
  setDownloadAbortController: vi.fn(),
  disconnectKeepalivePort: vi.fn(),
  setTabDownloadComplete: vi.fn(),
  removeDownloadsForTab: vi.fn(),
}));

vi.mock("../../src/background/scraper-state", () => ({
  stopScraping: vi.fn(),
  deleteScraper: vi.fn(),
}));

vi.mock("../../src/utils/MemoryManager", () => ({
  memoryManager: {
    forceCleanup: registry.forceCleanup,
    shutdown: registry.shutdown,
    getMemoryStats: registry.getMemoryStats,
  },
}));

// ---------------------------------------------------------------------------

import { messageActions } from "../../src/common/message";

type CleanupModule = typeof import("../../src/background/cleanupHandlers");

const CHECKPOINT = {
  downloadInterrupted: true,
  serverSessionId: "sess-warm-1",
  tabId: 7,
  tabUrl: "https://example.com/",
  phase: "uploading",
  timestamp: 1_724_000_000_000,
};

/** Simulate a NEW service-worker instance: re-evaluates the module, whose
 *  auto-init at import time is the warm-wake path (no activate involved). */
async function freshWorkerLifetime(): Promise<CleanupModule> {
  vi.resetModules();
  return await import("../../src/background/cleanupHandlers");
}

/** Latest activate listener registered by a module instance. */
function getActivateListener(): (event: any) => void {
  const listeners = registry.selfListeners.activate ?? [];
  expect(listeners.length).toBeGreaterThan(0);
  return listeners[listeners.length - 1];
}

/** Dispatch activate (install/update) and return the waitUntil promise. */
function dispatchActivate(): Promise<void> {
  let waitUntilPromise: Promise<void> = Promise.resolve();
  getActivateListener()({
    waitUntil: (p: Promise<void>) => {
      waitUntilPromise = p;
    },
  });
  return waitUntilPromise;
}

/** Let fire-and-forget work settle before negative assertions. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("warm-restart startup cleanup (D5 / tasks 4.1–4.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Defaults: a download was in progress; a panel is connected.
    registry.storageLocalGet.mockResolvedValue({
      isDownloadInProgress: true,
    });
    registry.storageLocalSet.mockResolvedValue(undefined);
    registry.sendMessageToPanel.mockResolvedValue(undefined);
    registry.readAllCheckpoints.mockResolvedValue([CHECKPOINT]);
    registry.clearCheckpoint.mockResolvedValue(undefined);
    registry.forceCleanup.mockResolvedValue(undefined);
    registry.getMemoryStats.mockReturnValue({ memoryPressureLevel: 0 });
  });

  it("a warm wake (module init without activate) runs startup cleanup and notifies a connected panel", async () => {
    await freshWorkerLifetime();

    // No activate dispatched — the module-init trigger must run the cleanup.
    await vi.waitFor(() => {
      expect(registry.sendMessageToPanel).toHaveBeenCalledWith(
        messageActions.DOWNLOAD_INTERRUPTED,
        CHECKPOINT,
      );
    });

    expect(registry.storageLocalGet).toHaveBeenCalledWith(
      "isDownloadInProgress",
    );
    expect(registry.storageLocalSet).toHaveBeenCalledWith({
      isDownloadInProgress: false,
    });
    // Delivered checkpoint is cleared (undelivered ones are kept).
    expect(registry.clearCheckpoint).toHaveBeenCalledWith(
      CHECKPOINT.serverSessionId,
    );
  });

  it("retains the checkpoint when no panel is connected (flag still cleared)", async () => {
    registry.sendMessageToPanel.mockRejectedValue(
      new Error("Receiving end does not exist"),
    );

    await freshWorkerLifetime();

    await vi.waitFor(() => {
      expect(registry.storageLocalSet).toHaveBeenCalledWith({
        isDownloadInProgress: false,
      });
    });
    await settle();

    expect(registry.sendMessageToPanel).toHaveBeenCalledWith(
      messageActions.DOWNLOAD_INTERRUPTED,
      CHECKPOINT,
    );
    // Not delivered → kept for the panel-open CHECK_INTERRUPTED_DOWNLOAD
    // discovery.
    expect(registry.clearCheckpoint).not.toHaveBeenCalled();
  });

  it("runs at most once per worker lifetime (re-fired init and extra lifecycle events do not re-run it)", async () => {
    const mod = await freshWorkerLifetime();

    await vi.waitFor(() => {
      expect(registry.storageLocalSet).toHaveBeenCalledWith({
        isDownloadInProgress: false,
      });
    });
    expect(registry.storageLocalGet).toHaveBeenCalledTimes(1);

    // Re-enter init + fire the activate lifecycle event again.
    mod.initializeCleanupHandlers();
    mod.initializeCleanupHandlers();
    await dispatchActivate();
    await settle();

    expect(registry.storageLocalGet).toHaveBeenCalledTimes(1);
    expect(registry.storageLocalSet).toHaveBeenCalledTimes(1);
    expect(registry.sendMessageToPanel).toHaveBeenCalledTimes(1);
    expect(registry.clearCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("install/update: the activate listener is preserved and the lifetime still cleans up exactly once", async () => {
    await freshWorkerLifetime();

    // The activate listener is still registered (kept for install/update).
    expect(getActivateListener()).toBeTypeOf("function");

    // On a real install/update the worker's first wake (module init) runs
    // the cleanup, then activate fires — it must not run it a second time.
    await vi.waitFor(() => {
      expect(registry.storageLocalSet).toHaveBeenCalledWith({
        isDownloadInProgress: false,
      });
    });
    await dispatchActivate();
    await settle();

    expect(registry.storageLocalSet).toHaveBeenCalledTimes(1);
    expect(registry.sendMessageToPanel).toHaveBeenCalledTimes(1);
  });

  it("is a cheap no-op when nothing was interrupted (single storage get, no writes or pushes)", async () => {
    registry.storageLocalGet.mockResolvedValue({}); // no isDownloadInProgress

    await freshWorkerLifetime();

    await vi.waitFor(() => {
      expect(registry.storageLocalGet).toHaveBeenCalledTimes(1);
    });
    await settle();

    expect(registry.storageLocalGet).toHaveBeenCalledWith(
      "isDownloadInProgress",
    );
    expect(registry.readAllCheckpoints).not.toHaveBeenCalled();
    expect(registry.storageLocalSet).not.toHaveBeenCalled();
    expect(registry.sendMessageToPanel).not.toHaveBeenCalled();
    expect(registry.clearCheckpoint).not.toHaveBeenCalled();
  });

  it("is fire-and-forget: a failing cleanup never throws out of init nor leaves an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      registry.storageLocalGet.mockRejectedValue(
        new Error("storage unavailable"),
      );

      // Module init must complete even though startup cleanup fails.
      await expect(freshWorkerLifetime()).resolves.toBeDefined();
      await settle();

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

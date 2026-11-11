/**
 * (multipage-download-fixes 5.3b + 5.3c) Interrupted declarations require
 * liveness evidence; paused checkpoints never produce the interrupted card.
 *
 * DEFECT AT HEAD: the startup cleanup push (cleanupHandlers.ts) converts a
 * stale `isDownloadInProgress` flag + checkpoint into DOWNLOAD_INTERRUPTED
 * with no liveness check — a checkpoint exists for the WHOLE run, and a
 * worker wake can race a still-live download (or a parked pause).
 *
 * NEW CONTRACT: before pushing DOWNLOAD_INTERRUPTED for a checkpoint the
 * system requires (a) the checkpoint's age to exceed a staleness bound AND
 * (b) no fresh persisted liveness heartbeat. A `paused` checkpoint is NEVER
 * pushed as interrupted (§4/D2 — it routes to the Paused card).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Chrome + self mock — must exist BEFORE cleanupHandlers is imported.
// Includes chrome.storage.session so the REAL download-liveness module can
// read the persisted heartbeat record.
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

  const sessionStore: Record<string, unknown> = {};
  const session = {
    get: async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return { ...sessionStore };
      const wanted = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of wanted) {
        if (k in sessionStore) out[k] = sessionStore[k];
      }
      return out;
    },
    set: async (objs: Record<string, unknown>) => {
      Object.assign(sessionStore, objs);
    },
    remove: async (keys: string | string[]) => {
      for (const k of typeof keys === "string" ? [keys] : keys) {
        delete sessionStore[k];
      }
    },
  };

  const selfListeners: Record<string, Array<(event: any) => void>> = {};
  const g = globalThis as any;
  g.self = g.self ?? {};
  g.self.addEventListener = (type: string, listener: any) => {
    (selfListeners[type] ??= []).push(listener);
  };

  g.chrome = {
    ...(g.chrome ?? {}),
    storage: {
      ...(g.chrome?.storage ?? {}),
      local: { get: mocks.storageLocalGet, set: mocks.storageLocalSet },
      session,
    },
    alarms: { create: mocks.alarmsCreate, onAlarm: mocks.alarmsOnAlarm },
    tabs: { onRemoved: mocks.tabsOnRemoved },
    runtime: {
      onSuspend: mocks.runtimeOnSuspend,
      onInstalled: mocks.runtimeOnInstalled,
    },
  };

  return { ...mocks, selfListeners, sessionStore };
});

vi.mock("../../src/background/message", () => ({
  sendMessageToPanel: registry.sendMessageToPanel,
  deleteServerSessionState: vi.fn(),
}));

vi.mock("../../src/background/download-checkpoint", () => ({
  readCheckpoint: vi.fn().mockResolvedValue(null),
  readAllCheckpoints: registry.readAllCheckpoints,
  clearCheckpoint: registry.clearCheckpoint,
  pauseCheckpoint: vi.fn(async () => {}),
  restoreCheckpointPhase: vi.fn(async () => {}),
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

import { messageActions } from "../../src/common/message";

type CleanupModule = typeof import("../../src/background/cleanupHandlers");

const STALE_CHECKPOINT = {
  downloadInterrupted: true,
  serverSessionId: "sess-dead",
  tabId: 7,
  tabUrl: "https://example.com/",
  phase: "uploading",
  timestamp: Date.now() - 10 * 60_000, // minutes old — the worker is long dead
};

async function freshWorkerLifetime(): Promise<CleanupModule> {
  vi.resetModules();
  return await import("../../src/background/cleanupHandlers");
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("startup interrupted push requires liveness evidence (5.3b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(registry.sessionStore)) {
      delete registry.sessionStore[key];
    }
    registry.storageLocalGet.mockResolvedValue({ isDownloadInProgress: true });
    registry.storageLocalSet.mockResolvedValue(undefined);
    registry.sendMessageToPanel.mockResolvedValue(undefined);
    registry.readAllCheckpoints.mockResolvedValue([STALE_CHECKPOINT]);
    registry.clearCheckpoint.mockResolvedValue(undefined);
    registry.forceCleanup.mockResolvedValue(undefined);
    registry.getMemoryStats.mockReturnValue({ memoryPressureLevel: 0 });
  });

  it("a genuinely dead download (stale checkpoint, no heartbeat) IS declared interrupted", async () => {
    await freshWorkerLifetime();

    await vi.waitFor(() => {
      expect(registry.sendMessageToPanel).toHaveBeenCalledWith(
        messageActions.DOWNLOAD_INTERRUPTED,
        STALE_CHECKPOINT,
      );
    });
    expect(registry.clearCheckpoint).toHaveBeenCalledWith("sess-dead");
  });

  it("a FRESH persisted heartbeat blocks the declaration — the download is proven live", async () => {
    await chrome.storage.session.set({
      "downloadLiveness:sess-dead": {
        serverSessionId: "sess-dead",
        heartbeatAt: Date.now() - 5_000, // well inside the 90 s bound
      },
    });

    await freshWorkerLifetime();
    await settle();

    expect(registry.sendMessageToPanel).not.toHaveBeenCalledWith(
      messageActions.DOWNLOAD_INTERRUPTED,
      STALE_CHECKPOINT,
    );
    // The checkpoint is retained for later discovery (panel open).
    expect(registry.clearCheckpoint).not.toHaveBeenCalledWith("sess-dead");
  });

  it("a just-written checkpoint (younger than the staleness bound) is not declared yet", async () => {
    registry.readAllCheckpoints.mockResolvedValue([
      { ...STALE_CHECKPOINT, timestamp: Date.now() - 2_000 },
    ]);

    await freshWorkerLifetime();
    await settle();

    expect(registry.sendMessageToPanel).not.toHaveBeenCalledWith(
      messageActions.DOWNLOAD_INTERRUPTED,
      expect.objectContaining({ serverSessionId: "sess-dead" }),
    );
  });

  it("a PAUSED checkpoint is never pushed as interrupted — parked, not dead (5.3c)", async () => {
    const parked = {
      ...STALE_CHECKPOINT,
      serverSessionId: "sess-parked",
      phase: "paused",
      previousPhase: "scraping",
      timestamp: Date.now() - 10 * 60_000,
    };
    registry.readAllCheckpoints.mockResolvedValue([parked]);

    await freshWorkerLifetime();
    await settle();

    expect(registry.sendMessageToPanel).not.toHaveBeenCalledWith(
      messageActions.DOWNLOAD_INTERRUPTED,
      parked,
    );
    // The park stays discoverable for Resume-from-park / parked Stop.
    expect(registry.clearCheckpoint).not.toHaveBeenCalledWith("sess-parked");
  });
});

// ---------------------------------------------------------------------------
// (5.3c) Panel-side routing: a checkpoint's phase decides the card. The
// CHECK_INTERRUPTED_DOWNLOAD pull and the DOWNLOAD_INTERRUPTED push both
// route through this decision — paused NEVER becomes the interrupted card.
// ---------------------------------------------------------------------------

import { interruptedPresentation } from "../../src/sidepanel/utils/interruptedRouting";

describe("interruptedPresentation routing (5.3c)", () => {
  it("routes a paused checkpoint to the paused card", () => {
    expect(interruptedPresentation({ phase: "paused" })).toBe("paused");
  });

  it("routes every other phase to the interrupted card", () => {
    expect(interruptedPresentation({ phase: "scraping" })).toBe("interrupted");
    expect(interruptedPresentation({ phase: "uploading" })).toBe("interrupted");
    expect(interruptedPresentation({ phase: "assembling" })).toBe(
      "interrupted",
    );
    expect(interruptedPresentation({})).toBe("interrupted");
    expect(interruptedPresentation(null)).toBe("interrupted");
    expect(interruptedPresentation(undefined)).toBe("interrupted");
  });
});

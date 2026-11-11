/**
 * (multipage-download-fixes 5.4 + 5.1) Assembly heartbeat.
 *
 * DEFECT AT HEAD: during the assembly-status poll the only panel pushes are
 * the server's phase-change callbacks — a long silent merge
 * (zip_assembler's merging phase) produces NO pushes for minutes. The
 * panel's 45 s watchdog reads that silence as worker death.
 *
 * NEW CONTRACT: the assembly poll emits a lightweight `status.assemblyProgress`
 * tick at a fixed cadence (~15 s) while it waits, and each tick refreshes
 * the persisted liveness record (5.1) so a closed panel (no poll-acks)
 * still leaves a fresh heartbeat behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Controllable assembly poll — downloadWithFallback hangs until released
// (simulating a long silent merge with NO phase-change callbacks).
// ---------------------------------------------------------------------------

const registry = vi.hoisted(() => {
  const pending: Array<(value: any) => void> = [];
  return {
    pending,
    releaseAssembly: (value: any) => {
      for (const resolve of pending.splice(0)) resolve(value);
    },
  };
});

// ---------------------------------------------------------------------------
// Chrome additions — storage.session fake + keepalive port stub (setup.cjs
// provides storage.local only).
// ---------------------------------------------------------------------------

let sessionStore: Record<string, unknown>;

function installSessionStorage(): void {
  sessionStore = {};
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
  (globalThis as any).chrome = {
    ...((globalThis as any).chrome ?? {}),
    storage: { ...((globalThis as any).chrome?.storage ?? {}), session },
    runtime: {
      ...((globalThis as any).chrome?.runtime ?? {}),
      connect: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Module mocks (mirrors download-liveness.test.ts's harness)
// ---------------------------------------------------------------------------

vi.mock("../../src/background/server-client", () => {
  const mocks: Record<string, vi.Mock> = {};
  for (const m of [
    "createSession",
    "uploadHtmlChunk",
    "scrapeComplete",
    "uploadResource",
    "uploadContent",
    "uploadPageContent",
    "uploadFilenameMap",
    "finalizeSession",
    "getSessionStatus",
    "checkHealth",
    "deleteSession",
  ]) {
    mocks[m] = vi.fn();
  }
  return {
    __esModule: true,
    serverClient: mocks,
    assertSecureBaseUrl: vi.fn(),
    ServerUnavailableError: class extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "ServerUnavailableError";
      }
    },
    AuthenticationError: class extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "AuthenticationError";
      }
    },
    AssemblyTimeoutError: class extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "AssemblyTimeoutError";
      }
    },
    HttpError: class extends Error {
      statusCode: number;
      constructor(message: string, statusCode: number) {
        super(message);
        this.name = "HttpError";
        this.statusCode = statusCode;
      }
    },
    upgradeInsecureServerUrl: vi.fn((url: string) => url),
  };
});

vi.mock("../../src/background/jobs", () => ({
  scrollDownAndScrape: vi.fn(),
  startDownload: vi.fn(),
}));

vi.mock("../../src/background/download", () => ({
  downloadResourcesWithIncrementalAssembly: vi.fn(),
}));

vi.mock("../../src/background/merge-html", () => ({
  mergeHtmlIncremental: vi.fn(),
}));

vi.mock("../../src/background/scraper-state", () => ({
  pauseScraping: vi.fn(),
  resumeScraping: vi.fn(),
  stopScraping: vi.fn(),
  setCurrentScraper: vi.fn(),
}));

vi.mock("../../src/background/download-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/background/download-core")>();
  return {
    ...actual,
    resumeServerDownload: vi.fn(),
  };
});

vi.mock("../../src/background/cleanupHandlers", () => ({
  cleanupAfterDownload: vi.fn(async () => {}),
}));
vi.mock("../../src/background/download-utils", () => ({
  performInitialCleanup: vi.fn(async () => {}),
}));
vi.mock("../../src/background/resources", () => ({
  getResources: vi.fn(() => ({
    images: [],
    css: [],
    js: [],
    links: [],
    documents: [],
    text: "",
  })),
}));
vi.mock("../../src/background/download-processors", () => ({
  processImages: vi.fn(async () => new Map()),
  processAssets: vi.fn(async () => new Map()),
  processDocuments: vi.fn(async () => new Map()),
  mergeFilenameMaps: vi.fn(
    (...maps: Array<Map<string, string> | undefined>) => {
      const merged = new Map<string, string>();
      for (const map of maps) {
        if (!map) continue;
        for (const [key, value] of map) merged.set(key, value);
      }
      return merged;
    },
  ),
}));
vi.mock("../../src/background/storage/server-storage-adapter", () => ({
  ServerStorageAdapter: class {
    setSessionId() {}
    getUploadQueue() {
      return {
        onProgress: null,
        onSessionFull: null,
        cancel: () => {},
        getResourceUrls: () => [],
        getResourceCount: () => 0,
        getProgress: () => ({
          totalCount: 0,
          completedCount: 0,
          failedCount: 0,
          bytesUploaded: 0,
          totalBytes: 0,
        }),
        waitForAll: async () => {},
        isSessionFull: () => false,
      };
    }
  },
}));
vi.mock("../../src/background/upload-queue", () => ({
  UploadQueue: class {},
}));

vi.mock("../../src/background/server-download", () => ({
  getServerDownloadHandler: vi.fn(() => ({
    downloadWithFallback: vi.fn(
      (
        _sessionId: string,
        _tabUrl: string,
        _singleFile: boolean,
        _fallback: unknown,
        _onStatus: unknown,
        _tabId: number | undefined,
        _saveAs: boolean,
        _signal: AbortSignal | undefined,
      ) =>
        new Promise<any>((resolve) => {
          // Hangs until the test releases it — a silent merge with zero
          // phase-change callbacks. (Plain resolve capture, no timers.)
          registry.pending.push(resolve);
        }),
    ),
  })),
  AssemblyFailedError: class extends Error {},
}));

vi.mock("../../src/background/download-checkpoint", () => ({
  readCheckpoint: vi.fn(async () => null),
  clearCheckpoint: vi.fn(async () => {}),
  writeCheckpoint: vi.fn(async () => {}),
  updateCheckpointPhase: vi.fn(),
  updateCheckpointResourceUrls: vi.fn(async () => {}),
  pauseCheckpoint: vi.fn(async () => {}),
  restoreCheckpointPhase: vi.fn(async () => {}),
}));

import { downloadResources } from "../../src/background/download-core";
import { serverClient } from "../../src/background/server-client";
import { getResources } from "../../src/background/resources";
import { markSessionNotLive } from "../../src/background/download-state";
import type { FilterOptions } from "../../src/types/filterTypes";

function serverDownloadOptions(
  overrides: Partial<FilterOptions> = {},
): FilterOptions {
  return {
    downloadHTML: true,
    downloadImages: false,
    downloadLinks: false,
    downloadAssets: false,
    downloadContentAsText: false,
    downloadDocuments: false,
    singleFile: false,
    ...overrides,
  } as FilterOptions;
}

const keysOf = (sendMessage: vi.Mock): string[] =>
  sendMessage.mock.calls.map((call) => (call[0] as { key: string }).key);

const assemblyPushes = (sendMessage: vi.Mock) =>
  sendMessage.mock.calls.filter(
    (call) => (call[0] as { key: string }).key === "status.assemblyProgress",
  );

const livenessRecord = () =>
  sessionStore["downloadLiveness:sess-hb"] as
    | { serverSessionId: string; heartbeatAt: number }
    | undefined;

describe("assembly heartbeat during a silent merge (5.4)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry.pending.length = 0;
    installSessionStorage();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(serverClient.createSession).mockResolvedValue("sess-hb");
    vi.mocked(serverClient.getSessionStatus).mockResolvedValue({
      status: "ready",
      download_url: "https://server.example.com/dl",
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    markSessionNotLive("sess-hb");
  });

  it("pushes a progress tick every ~15 s during a silent merge and refreshes the liveness record", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn();
    const done = downloadResources(
      "<html><body>page</body></html>",
      "https://fixture.test/page.html",
      serverDownloadOptions(),
      sendMessage,
      undefined,
      7001,
    );

    // Drive the flow to the assembly poll (status.assemblingServer pushed
    // right before downloadWithFallback hangs).
    for (
      let i = 0;
      i < 50 && !keysOf(sendMessage).includes("status.assemblingServer");
      i++
    ) {
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(keysOf(sendMessage)).toContain("status.assemblingServer");
    const pushesBeforeSilence = assemblyPushes(sendMessage).length;

    // 45 s of total server silence (no status callbacks at all):
    await vi.advanceTimersByTimeAsync(16_000);
    await vi.advanceTimersByTimeAsync(16_000);
    await vi.advanceTimersByTimeAsync(16_000);

    const pushes = assemblyPushes(sendMessage);
    // At HEAD this is 0 — the merge silence produces NO pushes and the
    // panel watchdog fires. After the fix: a fixed-cadence heartbeat.
    expect(pushes.length).toBeGreaterThan(pushesBeforeSilence + 2);

    // Each tick is an assemblyProgress message the watchdog routing accepts.
    for (const push of pushes) {
      expect((push[0] as { key: string }).key).toBe("status.assemblyProgress");
    }

    // (5.1) The persisted liveness record was refreshed during the merge —
    // a closed panel (no poll-acks) still finds a fresh heartbeat.
    const record = livenessRecord();
    expect(record).toBeDefined();
    expect(record!.serverSessionId).toBe("sess-hb");

    registry.releaseAssembly({ downloadUrl: "https://server.example.com/dl" });
    await done;
    expect(keysOf(sendMessage)).toContain("status.complete");
  });

  it("heartbeat ticks carry the downloadHtml flag for the honest merge wording (5.7)", async () => {
    vi.useFakeTimers();
    // A text-only run must have text content, or the zero-content abort
    // (Fix C) skips the pipeline entirely.
    vi.mocked(getResources).mockReturnValue({
      images: [],
      css: [],
      js: [],
      links: [],
      documents: [],
      text: "main page text",
    } as ReturnType<typeof getResources>);
    const sendMessage = vi.fn();
    const done = downloadResources(
      "<html><body>page</body></html>",
      "https://fixture.test/page.html",
      serverDownloadOptions({
        downloadHTML: false,
        downloadContentAsText: true,
      }),
      sendMessage,
      undefined,
      7002,
    );

    for (
      let i = 0;
      i < 50 && !keysOf(sendMessage).includes("status.assemblingServer");
      i++
    ) {
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(16_000);

    const pushes = assemblyPushes(sendMessage);
    expect(pushes.length).toBeGreaterThan(0);
    const options = (pushes[pushes.length - 1][0] as { options?: any }).options;
    expect(options.downloadHtml).toBe(false);

    registry.releaseAssembly({ downloadUrl: "https://server.example.com/dl" });
    await done;
  });
});

/**
 * Tests for the MAIN-path stop contract (stop-cancel-semantics, task 4.4 /
 * design D1): pressing Stop during the server-mode upload drain must
 * interrupt the flow, salvage the partial archive, and terminate as
 * status.cancelled — NEVER as status.complete.
 *
 * The stop is pressed through the REAL abortActiveDownload (download-state),
 * i.e. exactly what SCRAPER_STOP does; everything the flow needs beyond that
 * (server client, assembly poll handler, upload queue) is mocked.
 *
 * Covers:
 * - Stop during the upload drain → salvage probe (ONE getSessionStatus) →
 *   status.cancelled with serverSessionId/failedCount; when the probe finds
 *   the session ready, status.serverDownloadReady accompanies it.
 * - The post-poll race guard: a stop landing after the poll returned still
 *   reports cancelled, never complete.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted state shared with the vi.mock factories below (factories run at
// import time — plain module consts would be in the TDZ).
// ---------------------------------------------------------------------------

const queueHolder = vi.hoisted(() => ({ current: null as any }));
const handlerMock = vi.hoisted(() => ({
  downloadWithFallback: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — the flow is driven through the real downloadResources up to the
// upload drain; only the server/queue/poll collaborators are replaced.
// ---------------------------------------------------------------------------

vi.mock("../../src/background/cleanupHandlers", () => ({
  cleanupAfterDownload: vi.fn(async () => {}),
}));

vi.mock("../../src/background/download-checkpoint", () => ({
  writeCheckpoint: vi.fn(async () => {}),
  updateCheckpointPhase: vi.fn(),
  updateCheckpointResourceUrls: vi.fn(async () => {}),
  clearCheckpoint: vi.fn(async () => {}),
}));

vi.mock("../../src/background/download-utils", () => ({
  performInitialCleanup: vi.fn(async () => {}),
}));

vi.mock("../../src/background/resources", () => ({
  getResources: vi.fn(() => ({
    images: ["https://fixture.test/a.png"],
    css: [],
    js: [],
    links: [],
    documents: [],
    text: "",
  })),
}));

vi.mock("../../src/background/download-processors", () => ({
  processImages: vi.fn(
    async () => new Map([["https://fixture.test/a.png", "images/a.png"]]),
  ),
  processAssets: vi.fn(async () => new Map()),
  processDocuments: vi.fn(async () => new Map()),
  mergeFilenameMaps: (...maps: Array<Map<string, string> | undefined>) => {
    const merged = new Map<string, string>();
    for (const map of maps) {
      if (!map) continue;
      for (const [key, value] of map) {
        if (!merged.has(key)) merged.set(key, value);
      }
    }
    return merged;
  },
}));

vi.mock("../../src/background/linked-page-scraper", () => ({
  LinkedPageScraper: class {},
}));

vi.mock("../../src/background/storage/server-storage-adapter", () => ({
  ServerStorageAdapter: class {
    setSessionId() {}
    getUploadQueue() {
      return queueHolder.current;
    }
  },
}));

vi.mock("../../src/background/server-client", () => {
  class ServerUnavailableError extends Error {
    constructor(message = "server unavailable") {
      super(message);
      this.name = "ServerUnavailableError";
    }
  }
  class AuthenticationError extends Error {
    constructor(message = "auth failed") {
      super(message);
      this.name = "AuthenticationError";
    }
  }
  class AssemblyTimeoutError extends Error {
    constructor(message = "assembly timeout") {
      super(message);
      this.name = "AssemblyTimeoutError";
    }
  }
  // download-core references HttpError in its error mapping (task 6.5);
  // pagepocket-client (loaded transitively via cloud-binding) imports
  // assertSecureBaseUrl at module load.
  class HttpError extends Error {
    statusCode: number;
    errorCode?: string;
    constructor(message: string, statusCode: number, errorCode?: string) {
      super(message);
      this.name = "HttpError";
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }
  return {
    serverClient: {
      baseUrl: "https://server.example.com",
      createSession: vi.fn(async () => "sess-main-stop"),
      uploadHtmlChunk: vi.fn(async () => undefined),
      uploadFilenameMap: vi.fn(async () => undefined),
      uploadContent: vi.fn(async () => undefined),
      scrapeComplete: vi.fn(async () => undefined),
      finalizeSession: vi.fn(async () => undefined),
      getSessionStatus: vi.fn(),
    },
    assertSecureBaseUrl: vi.fn(),
    upgradeInsecureServerUrl: vi.fn((url: string) => url),
    ServerUnavailableError,
    AuthenticationError,
    AssemblyTimeoutError,
    HttpError,
  };
});

vi.mock("../../src/background/upload-queue", () => ({
  UploadQueue: class {},
}));

vi.mock("../../src/background/server-download", () => ({
  getServerDownloadHandler: vi.fn(() => ({
    downloadWithFallback: handlerMock.downloadWithFallback,
  })),
  AssemblyFailedError: class extends Error {},
}));

vi.mock("../../src/background/scraper-state", () => ({
  setCurrentScraper: vi.fn(),
  stopScraping: vi.fn(),
}));

vi.mock("../../src/background/message", () => ({
  setActiveServerSession: vi.fn(),
  getActiveServerSessionId: vi.fn(() => null),
  hasStreamedHtmlChunks: vi.fn(() => false),
}));

vi.mock("../../src/common/storage/filterStorage", () => ({
  loadFilterOptions: vi.fn(async () => ({})),
}));

// ---------------------------------------------------------------------------

import { downloadResources } from "../../src/background/download-core";
import { abortActiveDownload } from "../../src/background/download-state";
import { serverClient } from "../../src/background/server-client";
import type { FilterOptions } from "../../src/types/filterTypes";

// tests/setup.cjs provides chrome.storage.local; createKeepalivePort needs
// chrome.runtime.connect as well. The port exposes onMessage AND
// onDisconnect (D2 / task 2.1 — panel-close liveness).
(globalThis.chrome as { runtime?: unknown }).runtime = {
  connect: () => ({
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} },
    postMessage: () => {},
    disconnect: () => {},
  }),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a mock function from the mocked serverClient singleton. */
function sc(method: string): vi.Mock {
  return (serverClient as any)[method] as vi.Mock;
}

/**
 * Controlled upload queue: 3 resources, 2 terminally failed (the failedCount
 * the cancellation payload must carry). `autoResolve` lets the drain finish
 * cleanly; otherwise waitForAll stays pending until cancel() rejects it.
 */
function makeControlledQueue(opts: { autoResolve?: boolean } = {}) {
  const waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  const queue = {
    onProgress: null as any,
    onSessionFull: null as any,
    cancel: vi.fn(() => {
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error("UploadQueue was cancelled"));
      }
    }),
    getResourceCount: vi.fn(() => 3),
    getResourceUrls: vi.fn(() => [] as string[]),
    isSessionFull: vi.fn(() => false),
    isCancelled: vi.fn(() => false),
    getProgress: vi.fn(() => ({
      completedCount: 1,
      failedCount: 2,
      totalCount: 3,
      bytesUploaded: 128,
      totalBytes: 1024,
    })),
    waitForAll: vi.fn(() =>
      opts.autoResolve
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) =>
            waiters.push({ resolve, reject }),
          ),
    ),
  };
  return queue;
}

function sessionStatus(overrides: Record<string, any> = {}) {
  return {
    id: "sess-main-stop",
    url: "https://fixture.test/page.html",
    status: "assembling",
    html_chunks: 1,
    resources_discovered: 3,
    resources_received: 3,
    total_size: 1024,
    assembly_phase: null,
    assembly_progress_pct: null,
    download_url: null,
    output_type: null,
    output_size: null,
    error_message: null,
    api_version: "v1",
    ...overrides,
  };
}

/**
 * Make the (mocked) assembly poll reject with the AbortError the moment the
 * assembly signal fires — what pollAssemblyStatus really does. If nothing
 * ever aborts it (pre-fix stop wiring), the poll "succeeds" after a short
 * delay so the pre-fix flow visibly produces status.complete instead of
 * hanging the test.
 */
function pollRejectsOnAbort(): void {
  handlerMock.downloadWithFallback.mockImplementation(
    (
      _sessionId: unknown,
      _tabUrl: unknown,
      _isSingleFile: unknown,
      _fallback: unknown,
      _onStatus: unknown,
      _tabId: unknown,
      _saveAs: unknown,
      signal?: AbortSignal,
    ) => {
      // Already stopped when the poll starts — reject immediately (an
      // already-aborted signal never fires a later "abort" event).
      if (signal?.aborted) {
        return Promise.reject(
          new DOMException("Assembly polling was cancelled", "AbortError"),
        );
      }
      return new Promise((resolve, reject) => {
        const giveUp = setTimeout(
          () =>
            resolve({
              downloadId: 1,
              downloadUrl:
                "http://server.example.com/downloads/sess-main-stop.zip",
              filename: "fixture.zip",
            }),
          250,
        );
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(giveUp);
            reject(
              new DOMException("Assembly polling was cancelled", "AbortError"),
            );
          },
          { once: true },
        );
      });
    },
  );
}

function runDownload(tabId: number, options: Partial<FilterOptions> = {}) {
  const sendMessage = vi.fn();
  const flow = downloadResources(
    "<html><body>fixture</body></html>",
    "https://fixture.test/page.html",
    { downloadHTML: true, ...options } as FilterOptions,
    sendMessage,
    undefined,
    tabId,
  );
  return { flow, sendMessage };
}

beforeEach(() => {
  vi.clearAllMocks();
  sc("getSessionStatus").mockReset();
  handlerMock.downloadWithFallback.mockReset();
  queueHolder.current = null;
});

// ---------------------------------------------------------------------------
// Tests — task 4.4 (D1: stop never reports success with partial data)
// ---------------------------------------------------------------------------

describe("main-path stop contract (stop-cancel-semantics, task 4.4)", () => {
  it("stop during the upload drain salvages and reports status.cancelled — never status.complete — surfacing the ready archive URL (task 4.4)", async () => {
    queueHolder.current = makeControlledQueue();
    // The salvage probe finds the session ALREADY ready with a URL.
    sc("getSessionStatus").mockResolvedValue(
      sessionStatus({
        status: "ready",
        download_url: "http://server.example.com/downloads/sess-main-stop.zip",
      }),
    );
    pollRejectsOnAbort();

    const { flow, sendMessage } = runDownload(31, { downloadImages: true });

    // Wait until the upload drain is waiting, then press Stop — the REAL
    // SCRAPER_STOP entry point (abortActiveDownload).
    await vi.waitFor(() =>
      expect(queueHolder.current.waitForAll).toHaveBeenCalled(),
    );
    abortActiveDownload(31);
    await flow;

    const messages = sendMessage.mock.calls.map((c) => c[0]);
    // NEVER a completion for a stopped download…
    expect(messages.some((m: any) => m?.key === "status.complete")).toBe(false);
    // …the terminal status is cancelled with session id + failedCount…
    const cancelled = messages.find((m: any) => m?.key === "status.cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled.options).toEqual({
      serverSessionId: "sess-main-stop",
      failedCount: 2,
    });
    // …and the partial archive the probe found accompanies the cancellation.
    const ready = messages.find(
      (m: any) => m?.key === "status.serverDownloadReady",
    );
    expect(ready).toBeDefined();
    expect(ready.options).toMatchObject({
      downloadUrl: "http://server.example.com/downloads/sess-main-stop.zip",
      serverSessionId: "sess-main-stop",
    });

    // Salvage cost: the session was finalized and probed exactly ONCE —
    // no continued polling after the stop.
    expect(sc("finalizeSession")).toHaveBeenCalledWith("sess-main-stop");
    expect(sc("getSessionStatus")).toHaveBeenCalledTimes(1);
  });

  it("a stop landing after the poll returned still reports cancelled, never complete (task 4.4 post-poll race guard)", async () => {
    queueHolder.current = makeControlledQueue({ autoResolve: true });
    handlerMock.downloadWithFallback.mockImplementation(async () => {
      // The stop fires after the poll returned but before the terminal
      // sends — the race the post-poll guard exists for.
      abortActiveDownload(32);
      return {
        downloadId: 1,
        downloadUrl: "http://server.example.com/downloads/sess-main-stop.zip",
        filename: "fixture.zip",
      };
    });

    const { flow, sendMessage } = runDownload(32, { downloadImages: true });
    await flow;

    const messages = sendMessage.mock.calls.map((c) => c[0]);
    expect(messages.some((m: any) => m?.key === "status.complete")).toBe(false);
    const cancelled = messages.find((m: any) => m?.key === "status.cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled.options).toEqual({
      serverSessionId: "sess-main-stop",
      failedCount: 2,
    });
    // The already-produced URL is surfaced via the ready affordance.
    const ready = messages.find(
      (m: any) => m?.key === "status.serverDownloadReady",
    );
    expect(ready).toBeDefined();
    expect(ready.options).toMatchObject({
      downloadUrl: "http://server.example.com/downloads/sess-main-stop.zip",
      serverSessionId: "sess-main-stop",
    });
    // The guard uses the poll result — no salvage probe is needed.
    expect(sc("getSessionStatus")).not.toHaveBeenCalled();
  });
});

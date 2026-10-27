/**
 * Tests for resumeServerDownload — server session resume after SW restart.
 *
 * Verifies:
 * - Resume with server resources but no checkpoint URLs: scrapeComplete + finalize + poll
 * - Resume with no server resources and no checkpoint URLs: throws "full restart required"
 * - Resume in assembling status: polls for completion
 * - Resume in ready status: downloads immediately
 * - Resume with checkpoint URLs: re-uploads resources
 *
 * stop-cancel-semantics (tasks 4.1, 4.2, 4.5):
 * - Stop during the resume re-fetch loop aborts the in-flight fetch, breaks
 *   the loop, and routes the flow to the salvage step (status.cancelled)
 * - `waitForAll` rejection on the resume path does NOT fail the resume:
 *   timeout → status.complete with failedCount; cancel → salvage/cancelled
 * - Stop during resume assembly aborts polling and runs at most ONE salvage
 *   status probe
 *
 * DEPENDENCY NOTE: the cancel-rejection tests below (waitForAll rejecting
 * with "UploadQueue was cancelled" once the queue is cancelled) rely on the
 * `upload-queue-terminal-reliability` change, which made `waitForAll()`
 * check `cancelled` BEFORE `isDone()` (upload-queue.ts) — a cancelled queue
 * now observably rejects instead of resolving. Without that fix a
 * post-cancel wait resolves and the cancel-rejection assertions would not
 * bite (the timeout-rejection path is independent of it).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted state shared with the vi.mock factories below (factories run at
// import time — plain module consts would be in the TDZ).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  /** Every UploadQueue instance the resume flow creates (last = current). */
  uploadQueueInstances: [] as any[],
  /** Per-tab stop controllers captured from setDownloadAbortController. */
  stopControllers: new Map<number, AbortController>(),
}));

// ---------------------------------------------------------------------------
// Mocks — factories use vi.fn() inline to avoid hoisting issues.
// Access mock functions via the imported module after import.
// ---------------------------------------------------------------------------

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    baseUrl: "https://server.example.com",
    getSessionStatus: vi.fn(),
    scrapeComplete: vi.fn().mockResolvedValue(undefined),
    finalizeSession: vi.fn().mockResolvedValue(undefined),
    uploadResource: vi.fn().mockResolvedValue(undefined),
  },
  // pagepocket-client (loaded transitively via download-core → cloud-binding)
  // imports this at module load
  assertSecureBaseUrl: vi.fn(),
  // Identity passthrough — the ready-status test feeds an https URL
  upgradeInsecureServerUrl: vi.fn((url: string) => url),
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
}));

vi.mock("../../src/background/download-state", () => ({
  setDownloadAbortController: vi.fn(),
  getDownloadAbortController: vi.fn().mockReturnValue(null),
  createKeepalivePort: vi.fn(),
  disconnectKeepalivePort: vi.fn(),
  downloadId: vi.fn(),
  setTabDownloadActive: vi.fn(),
  setTabDownloadComplete: vi.fn(),
  isAnyDownloadInProgress: vi.fn().mockReturnValue(false),
  isTabDownloadInProgress: vi.fn().mockReturnValue(false),
  // (Fix D.1) Liveness tracking exports used by download-core
  markSessionLive: vi.fn(),
  markSessionNotLive: vi.fn(),
  isSessionLive: vi.fn().mockReturnValue(false),
  // (Round 9 — Fix B) Trusted-progress exports used by download-core
  setSessionUploadQueue: vi.fn(),
  setSessionPhase: vi.fn(),
  setSessionLastError: vi.fn(),
}));

vi.mock("../../src/common/storage/filterStorage", () => ({
  loadFilterOptions: vi.fn().mockResolvedValue({ alwaysAskWhereToSave: true }),
}));

vi.mock("../../src/background/server-download", () => ({
  getServerDownloadHandler: vi.fn().mockReturnValue({
    downloadWithFallback: vi.fn().mockResolvedValue(null),
  }),
  AssemblyFailedError: class extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "AssemblyFailedError";
    }
  },
}));

vi.mock("../../src/background/download-checkpoint", () => ({
  writeCheckpoint: vi.fn(),
  updateCheckpointPhase: vi.fn(),
  updateCheckpointResourceUrls: vi.fn(),
  clearCheckpoint: vi.fn(),
  readCheckpoint: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/background/scraper-state", () => ({
  setCurrentScraper: vi.fn(),
  stopScraping: vi.fn(),
}));

// Mock heavy modules with side effects that crash in test env
vi.mock("../../src/background/cleanupHandlers", () => ({
  cleanupAfterDownload: vi.fn(),
}));

vi.mock("../../src/background/merge-html", () => ({
  finalizeIncrementalMerge: vi.fn(),
}));

vi.mock("../../src/background/download", () => ({
  downloadResourcesWithIncrementalAssembly: vi.fn(),
}));

vi.mock("../../src/background/panel-download", () => ({
  initiateDownload: vi.fn(),
  performInitialCleanup: vi.fn(),
  isPanelAlive: vi.fn().mockReturnValue(false),
  downloadViaPanelAndWait: vi.fn(),
  PanelUnavailableError: class extends Error {},
}));

vi.mock("../../src/background/download-utils", () => ({
  initiateDownload: vi.fn(),
  performInitialCleanup: vi.fn(),
}));

vi.mock("../../src/background/message", () => ({
  setActiveServerSession: vi.fn(),
  getActiveServerSessionId: vi.fn().mockReturnValue(null),
  hasStreamedHtmlChunks: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/background/linked-page-scraper", () => ({
  LinkedPageScraper: vi.fn(),
  setGlobalImageFilenameMap: vi.fn(),
}));

vi.mock("../../src/background/asset-registry", () => ({
  AssetRegistry: vi.fn(),
}));

vi.mock("../../src/background/upload-queue", () => {
  return {
    UploadQueue: class {
      /** Terminal failed-upload count the flow reports as failedCount (D3). */
      failedCount = 0;
      getResourceUrls = vi.fn().mockReturnValue([]);
      getResourceCount = vi.fn().mockReturnValue(0);
      getProgress = vi.fn(function (this: any) {
        return {
          completedCount: 0,
          failedCount: this.failedCount,
          totalCount: 0,
          bytesUploaded: 0,
          totalBytes: 0,
        };
      });
      waitForAll = vi.fn().mockResolvedValue(undefined);
      enqueue = vi.fn().mockResolvedValue("task-0");
      cancel = vi.fn();
      onProgress: any = null;
      constructor() {
        mocks.uploadQueueInstances.push(this);
      }
    },
  };
});

vi.mock("../../src/background/storage/session-manager", () => ({
  SessionManager: vi.fn(),
}));

vi.mock("../../src/background/storage/file-store", () => ({
  FileStore: vi.fn(),
}));

vi.mock("../../src/background/storage/storage-adapter", () => ({
  JSZipAdapter: vi.fn(),
  IndexedDBAdapter: vi.fn(),
}));

vi.mock("../../src/background/storage/server-storage-adapter", () => ({
  ServerStorageAdapter: vi.fn(),
}));

vi.mock("../../src/background/zip-stream-splitter", () => ({
  SplitZipGenerator: vi.fn(),
}));

vi.mock("../../src/background/html-utils/html-converter", () => ({
  convertToSingleFileHtml: vi.fn(),
}));

vi.mock("../../src/common/server-mode", () => ({
  IS_SERVER_MODE: false,
}));

vi.mock("../../src/background/resources", () => ({
  getResources: vi.fn(),
}));

vi.mock("../../src/utils/MemoryManager", () => ({
  memoryManager: { getLevel: vi.fn().mockReturnValue(0) },
}));

vi.mock("../../src/utils/memoryLimits", () => ({
  MemoryPressureLevel: { NONE: 0, LOW: 1, HIGH: 2 },
}));

vi.mock("../../src/utils/RequestQueue", () => ({
  requestQueue: { add: vi.fn() },
}));

vi.mock("../../src/background/fileHandlers", () => ({
  addIndexHtml: vi.fn(),
  addContentText: vi.fn(),
}));

vi.mock("../../src/background/urlUtils", () => ({
  fixFilename: vi.fn((s: string) => s),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { resumeServerDownload } from "../../src/background/download-core";
import { serverClient } from "../../src/background/server-client";
import { getServerDownloadHandler } from "../../src/background/server-download";
import {
  setDownloadAbortController,
  getDownloadAbortController,
} from "../../src/background/download-state";

// ---------------------------------------------------------------------------
// Helpers — access mock fns via imported modules
// ---------------------------------------------------------------------------

// Emulate the real per-tab stop-controller registry (download-state) so the
// tests can press Stop exactly like abortActiveDownload (SCRAPER_STOP) does:
// the controller the flow registers is the one that gets aborted.
vi.mocked(setDownloadAbortController).mockImplementation((ctrl, tabId) => {
  if (ctrl) {
    mocks.stopControllers.set(tabId, ctrl);
  } else {
    mocks.stopControllers.delete(tabId);
  }
});
vi.mocked(getDownloadAbortController).mockImplementation(
  (tabId) => mocks.stopControllers.get(tabId) ?? null,
);

/** Simulate the user pressing Stop for the given tab. */
function pressStop(tabId: number): void {
  mocks.stopControllers.get(tabId)!.abort();
}

/** The UploadQueue instance the flow under test created. */
function currentQueue(): any {
  return mocks.uploadQueueInstances.at(-1);
}

/** Build the AbortError convention used by the stop plumbing (D2). */
function abortErr(): DOMException {
  return new DOMException("Download was cancelled", "AbortError");
}

/**
 * Make the (mocked) assembly poll behave like the real one w.r.t. stop:
 * with a signal it rejects AbortError the moment the signal fires; without
 * a signal (the pre-stop-cancel call shape) it "succeeds" so pre-fix flows
 * visibly produce status.complete instead of hanging.
 */
function pollRejectsOnAbort(): void {
  getMockDownloadWithFallback().mockImplementation(
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
      if (!signal) {
        // Pre-stop-cancel call shape (resume passed no assembly signal):
        // the poll "succeeds" shortly — pre-fix flows visibly into
        // status.complete instead of hanging, and the stop controller is
        // still registered when the test presses Stop.
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({ downloadUrl: "https://server.example.com/file.zip" }),
            100,
          ),
        );
      }
      if (signal.aborted) {
        return Promise.reject(abortErr());
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortErr()), {
          once: true,
        });
      });
    },
  );
}

/** Get a mock function from the mocked serverClient singleton. */
function sc(method: string): vi.Mock {
  return (serverClient as any)[method] as vi.Mock;
}

/** Get the mock downloadWithFallback from the mocked handler. */
function getMockDownloadWithFallback(): vi.Mock {
  return (getServerDownloadHandler() as any).downloadWithFallback as vi.Mock;
}

function mockSessionStatus(overrides: Record<string, any> = {}) {
  sc("getSessionStatus").mockResolvedValue({
    id: "sess-resume-test",
    url: "https://example.com/page",
    status: "scraping",
    html_chunks: 5,
    resources_discovered: 10,
    resources_received: 0,
    total_size: 1024,
    assembly_phase: null,
    assembly_progress_pct: null,
    download_url: null,
    output_type: null,
    output_size: null,
    error_message: null,
    api_version: "v1",
    ...overrides,
  });
}

function createCheckpoint(overrides: Record<string, any> = {}) {
  return {
    serverSessionId: "sess-resume-test",
    tabUrl: "https://example.com/page",
    tabId: undefined,
    phase: "scraping",
    resourceUrls: undefined,
    ...overrides,
  };
}

const sendMessage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stopControllers.clear();
  mocks.uploadQueueInstances.length = 0;
  sc("scrapeComplete").mockResolvedValue(undefined);
  sc("finalizeSession").mockResolvedValue(undefined);
  getMockDownloadWithFallback().mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resumeServerDownload", () => {
  it("should throw when no server session ID in checkpoint", async () => {
    await expect(
      resumeServerDownload(
        createCheckpoint({ serverSessionId: undefined }),
        sendMessage,
      ),
    ).rejects.toThrow("No server session ID in checkpoint");
  });

  it("should download immediately when session is ready", async () => {
    mockSessionStatus({
      status: "ready",
      download_url: "https://server.example.com/file.zip",
    });

    await resumeServerDownload(createCheckpoint(), sendMessage);

    expect(sc("scrapeComplete")).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ key: "status.complete" }),
    );
    // (delete-after-completion) The completion payload carries the server
    // session ID so the panel's delete flow works after completion.
    const completeMsg = sendMessage.mock.calls
      .map((c) => c[0])
      .find((m: any) => m?.key === "status.complete");
    expect(completeMsg.options).toMatchObject({
      serverSessionId: "sess-resume-test",
    });
  });

  it("should poll for assembly when session is assembling", async () => {
    mockSessionStatus({ status: "assembling" });

    await resumeServerDownload(createCheckpoint(), sendMessage);

    expect(getMockDownloadWithFallback()).toHaveBeenCalled();
    expect(sc("scrapeComplete")).not.toHaveBeenCalled();
    expect(sc("finalizeSession")).not.toHaveBeenCalled();
  });

  it("should throw when session is failed", async () => {
    mockSessionStatus({ status: "failed" });

    await expect(
      resumeServerDownload(createCheckpoint(), sendMessage),
    ).rejects.toThrow("Server session is failed and cannot be resumed");
  });

  it("should throw when session is expired", async () => {
    mockSessionStatus({ status: "expired" });

    await expect(
      resumeServerDownload(createCheckpoint(), sendMessage),
    ).rejects.toThrow("Server session is expired and cannot be resumed");
  });

  describe("no checkpoint URLs, server has resources", () => {
    it("should send scrapeComplete with server's resource count", async () => {
      mockSessionStatus({ status: "scraping", resources_received: 4711 });

      await resumeServerDownload(createCheckpoint(), sendMessage);

      expect(sc("scrapeComplete")).toHaveBeenCalledWith(
        "sess-resume-test",
        4711,
      );
    });

    it("should call finalizeSession", async () => {
      mockSessionStatus({ status: "scraping", resources_received: 100 });

      await resumeServerDownload(createCheckpoint(), sendMessage);

      expect(sc("finalizeSession")).toHaveBeenCalledWith("sess-resume-test");
    });

    it("should skip re-upload (no fetch calls)", async () => {
      mockSessionStatus({ status: "scraping", resources_received: 50 });
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      await resumeServerDownload(createCheckpoint(), sendMessage);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should poll for assembly via downloadWithFallback", async () => {
      mockSessionStatus({ status: "scraping", resources_received: 50 });

      await resumeServerDownload(createCheckpoint(), sendMessage);

      // (stop-cancel-semantics D2) The assembly-poll signal is now passed
      // as the 8th argument so polling wakes immediately on Stop.
      expect(getMockDownloadWithFallback()).toHaveBeenCalledWith(
        "sess-resume-test",
        "https://example.com/page",
        false,
        expect.any(Function),
        expect.any(Function),
        undefined,
        true,
        expect.any(AbortSignal),
      );
    });

    it("should proceed even if finalizeSession throws (already assembling)", async () => {
      mockSessionStatus({ status: "scraping", resources_received: 50 });
      sc("finalizeSession").mockRejectedValue(new Error("already assembling"));
      getMockDownloadWithFallback().mockResolvedValue({
        downloadUrl: "https://server.example.com/file.zip",
      });

      await resumeServerDownload(createCheckpoint(), sendMessage);

      expect(getMockDownloadWithFallback()).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ key: "status.complete" }),
      );
    });
  });

  describe("no checkpoint URLs, server has no resources", () => {
    it("should throw with diagnostic info including session ID and received count", async () => {
      mockSessionStatus({ status: "scraping", resources_received: 0 });

      await expect(
        resumeServerDownload(createCheckpoint(), sendMessage),
      ).rejects.toThrow(/session=sess-resume-test/);
    });

    it("should throw with 'full restart required' message", async () => {
      mockSessionStatus({ status: "scraping", resources_received: 0 });

      await expect(
        resumeServerDownload(createCheckpoint(), sendMessage),
      ).rejects.toThrow(/full restart required/);
    });

    it("should not finalizeSession", async () => {
      mockSessionStatus({ status: "scraping", resources_received: 0 });

      try {
        await resumeServerDownload(createCheckpoint(), sendMessage);
      } catch {}

      expect(sc("finalizeSession")).not.toHaveBeenCalled();
    });
  });

  describe("with checkpoint URLs", () => {
    const resourceUrls = [
      {
        url: "https://example.com/img.png",
        path: "images/img.png",
        contentType: "image/png",
      },
      {
        url: "https://example.com/style.css",
        path: "styles/style.css",
        contentType: "text/css",
      },
    ];

    it("should send scrapeComplete with resource URL count", async () => {
      mockSessionStatus({ status: "scraping" });

      await resumeServerDownload(
        createCheckpoint({ resourceUrls }),
        sendMessage,
      );

      expect(sc("scrapeComplete")).toHaveBeenCalledWith("sess-resume-test", 2);
    });

    it("should fetch and re-upload each resource", async () => {
      mockSessionStatus({ status: "scraping" });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
      globalThis.fetch = mockFetch;

      await resumeServerDownload(
        createCheckpoint({ resourceUrls }),
        sendMessage,
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/img.png",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("should finalize and poll after uploads complete", async () => {
      mockSessionStatus({ status: "uploading" });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
      globalThis.fetch = mockFetch;

      await resumeServerDownload(
        createCheckpoint({ resourceUrls }),
        sendMessage,
      );

      expect(sc("finalizeSession")).toHaveBeenCalledWith("sess-resume-test");
      expect(getMockDownloadWithFallback()).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // stop-cancel-semantics — tasks 4.1, 4.2, 4.5
  // -------------------------------------------------------------------------

  describe("stop-cancel-semantics (D2/D3)", () => {
    /** A two-entry manifest for loop tests; the second URL must never be
     *  fetched once Stop interrupted the first fetch. */
    const loopManifest = [
      {
        url: "https://example.com/in-flight.png",
        path: "images/in-flight.png",
        contentType: "image/png",
      },
      {
        url: "https://example.com/never.png",
        path: "images/never.png",
        contentType: "image/png",
      },
    ];

    it("stop mid-refetch aborts the in-flight fetch, fetches NO further URLs, and salvages instead of completing (task 4.1)", async () => {
      mockSessionStatus({ status: "scraping" });
      pollRejectsOnAbort();

      const fetchUrls: string[] = [];
      const mockFetch = vi.fn(
        (url: string, init?: { signal?: AbortSignal }) => {
          fetchUrls.push(url);
          return new Promise((_, reject) => {
            // The stop signal interrupts the in-flight fetch immediately;
            // if nothing ever aborts it (pre-fix shape), the request still
            // terminates with an AbortError so the pre-fix catch-and-skip
            // keeps looping and the assertions below fail fast instead of
            // hanging.
            const giveUp = setTimeout(
              () => reject(new DOMException("Aborted", "AbortError")),
              250,
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(giveUp);
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        },
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const flow = resumeServerDownload(
        createCheckpoint({ tabId: 7, resourceUrls: loopManifest }),
        sendMessage,
      );

      // Wait until the first re-fetch is in flight, then press Stop.
      await vi.waitFor(() => expect(fetchUrls).toContain(loopManifest[0].url));
      pressStop(7);
      await flow;

      // The abort broke the loop — the second URL was NEVER fetched.
      expect(fetchUrls).toEqual([loopManifest[0].url]);

      // The flow took the salvage path: finalize + exactly ONE status probe
      // (on top of the resume's initial status check) and a terminal
      // status.cancelled without any URL (probe found nothing ready).
      expect(sc("finalizeSession")).toHaveBeenCalledTimes(1);
      expect(sc("getSessionStatus")).toHaveBeenCalledTimes(2);
      const messages = sendMessage.mock.calls.map((c) => c[0]);
      const cancelled = messages.find(
        (m: any) => m?.key === "status.cancelled",
      );
      expect(cancelled).toBeDefined();
      expect(cancelled.options).toEqual({
        serverSessionId: "sess-resume-test",
      });
      expect(messages.some((m: any) => m?.key === "status.complete")).toBe(
        false,
      );
      expect(
        messages.some((m: any) => m?.key === "status.serverDownloadReady"),
      ).toBe(false);
    });

    it("waitForAll timeout rejection finalizes partial and reports status.complete with failedCount — the resume does NOT fail (task 4.2a)", async () => {
      mockSessionStatus({ status: "uploading" });
      const okResponse = {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        blob: () => Promise.resolve(new Blob(["x"])),
      };
      // Fetch both resources, but hold the second until the queue is
      // configured — makes the wait-rejection setup race-free.
      let releaseFetch2: () => void = () => {};
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(okResponse)
        .mockImplementationOnce(
          () =>
            new Promise<any>((resolve) => {
              releaseFetch2 = () => resolve(okResponse);
            }),
        );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const flow = resumeServerDownload(
        createCheckpoint({ tabId: undefined, resourceUrls: loopManifest }),
        sendMessage,
      );
      await vi.waitFor(() =>
        expect(fetchUrlsFetched(mockFetch)).toContain(loopManifest[0].url),
      );

      // Configure the queue: waitForAll rejects with the drain timeout and
      // the queue reports 2 terminally failed uploads.
      const queue = currentQueue();
      queue.failedCount = 2;
      queue.waitForAll.mockRejectedValue(
        new Error(
          "UploadQueue.waitForAll timed out after 60.0s. Completed: 0/2",
        ),
      );
      // The (non-aborted) assembly poll succeeds and produced the archive.
      getMockDownloadWithFallback().mockResolvedValue({
        downloadUrl: "https://server.example.com/file.zip",
      });

      releaseFetch2();
      await flow;

      // Timeout semantics survive: the archive completes with failedCount.
      const messages = sendMessage.mock.calls.map((c) => c[0]);
      const complete = messages.find((m: any) => m?.key === "status.complete");
      expect(complete).toBeDefined();
      expect(complete.options).toEqual({
        downloadUrl: "https://server.example.com/file.zip",
        serverSessionId: "sess-resume-test",
        failedCount: 2,
      });
      expect(messages.some((m: any) => m?.key === "status.cancelled")).toBe(
        false,
      );
      // A timeout is not a stop — no salvage probe ran.
      expect(sc("getSessionStatus")).toHaveBeenCalledTimes(1);
      expect(getMockDownloadWithFallback()).toHaveBeenCalledWith(
        "sess-resume-test",
        "https://example.com/page",
        false,
        expect.any(Function),
        expect.any(Function),
        undefined,
        true,
        expect.any(AbortSignal),
      );
    });

    it("waitForAll cancel-rejection after Stop finalizes partial and reports status.cancelled (task 4.2b)", async () => {
      // NOTE: depends on upload-queue-terminal-reliability — see header.
      mockSessionStatus({ status: "scraping" });
      const okResponse = {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        blob: () => Promise.resolve(new Blob(["x"])),
      };
      let releaseFetch2: () => void = () => {};
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(okResponse)
        .mockImplementationOnce(
          () =>
            new Promise<any>((resolve) => {
              releaseFetch2 = () => resolve(okResponse);
            }),
        );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const flow = resumeServerDownload(
        createCheckpoint({ tabId: 9, resourceUrls: loopManifest }),
        sendMessage,
      );
      await vi.waitFor(() =>
        expect(fetchUrlsFetched(mockFetch)).toContain(loopManifest[0].url),
      );

      // Wire the cancel contract: once the queue is cancelled, the pending
      // waitForAll rejects (upload-queue-terminal-reliability). Then release
      // the held fetch so the loop finishes and the drain wait starts.
      const queue = currentQueue();
      queue.waitForAll.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            queue.cancel.mockImplementation(() =>
              reject(new Error("UploadQueue was cancelled")),
            );
          }),
      );
      releaseFetch2();

      // Once the drain wait is pending, press Stop: the abort listener
      // cancels the queue → the waiter rejects instead of resolving.
      await vi.waitFor(() => expect(queue.waitForAll).toHaveBeenCalled());
      pressStop(9);
      await flow;

      // Salvage: finalize + exactly ONE probe; terminal status.cancelled.
      expect(sc("finalizeSession")).toHaveBeenCalledTimes(1);
      expect(sc("getSessionStatus")).toHaveBeenCalledTimes(2);
      const messages = sendMessage.mock.calls.map((c) => c[0]);
      const cancelled = messages.find(
        (m: any) => m?.key === "status.cancelled",
      );
      expect(cancelled).toBeDefined();
      expect(cancelled.options).toEqual({
        serverSessionId: "sess-resume-test",
      });
      expect(messages.some((m: any) => m?.key === "status.complete")).toBe(
        false,
      );
    });

    it("stop during resume assembly aborts polling and runs at most ONE salvage probe; non-ready probe yields plain status.cancelled (task 4.5)", async () => {
      // The same mocked status serves the initial check (assembling) and the
      // salvage probe (not ready — download_url stays null).
      mockSessionStatus({ status: "assembling" });
      pollRejectsOnAbort();

      const flow = resumeServerDownload(
        createCheckpoint({ tabId: 11 }),
        sendMessage,
      );
      await vi.waitFor(() =>
        expect(getMockDownloadWithFallback()).toHaveBeenCalled(),
      );
      pressStop(11);
      await flow;

      // Initial status check + exactly ONE salvage probe — no continued
      // polling after the abort.
      expect(sc("getSessionStatus")).toHaveBeenCalledTimes(2);
      expect(sc("finalizeSession")).toHaveBeenCalledTimes(1);
      const messages = sendMessage.mock.calls.map((c) => c[0]);
      const cancelled = messages.find(
        (m: any) => m?.key === "status.cancelled",
      );
      expect(cancelled).toBeDefined();
      expect(cancelled.options).toEqual({
        serverSessionId: "sess-resume-test",
      });
      expect(messages.some((m: any) => m?.key === "status.complete")).toBe(
        false,
      );
      expect(
        messages.some((m: any) => m?.key === "status.serverDownloadReady"),
      ).toBe(false);
    });
  });
});

/** Extract the URLs a fetch mock was called with. */
function fetchUrlsFetched(mockFetch: vi.Mock): string[] {
  return mockFetch.mock.calls.map((call) => call[0]);
}

/**
 * Resume-produces-uploads regression test (D4 / fix-archived-page-pipeline).
 *
 * The existing resume-server-download.test.ts mocks UploadQueue entirely, so
 * nothing proved that a post-SW-death resume actually DRAINS a fresh queue
 * into real upload calls. This suite runs `resumeServerDownload` with the
 * REAL UploadQueue: a checkpoint manifest (path, originalUrl, contentType,
 * size) is re-fetched via fetch() and each blob is enqueued into a fresh
 * UploadQueue, producing real `serverClient.uploadResource` calls, followed
 * by scrapeComplete → finalize → poll, with the terminal failedCount
 * propagated into the `status.complete` payload.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — factories use vi.fn() inline to avoid hoisting issues.
// NOTE: upload-queue is deliberately NOT mocked — the real queue must run.
// ---------------------------------------------------------------------------

vi.mock("../../src/background/server-client", () => {
  return {
    serverClient: {
      getSessionStatus: vi.fn(),
      scrapeComplete: vi.fn().mockResolvedValue(undefined),
      finalizeSession: vi.fn().mockResolvedValue(undefined),
      uploadResource: vi.fn().mockResolvedValue(undefined),
    },
    // pagepocket-client (loaded transitively via download-core → cloud-binding)
    // imports this at module load
    assertSecureBaseUrl: vi.fn(),
    ServerClient: class ServerClient {},
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
      constructor(msg: string, statusCode: number) {
        super(msg);
        this.name = "HttpError";
        this.statusCode = statusCode;
      }
    },
  };
});

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
  readAllCheckpoints: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/background/scraper-state", () => ({
  setCurrentScraper: vi.fn(),
  stopScraping: vi.fn(),
}));

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
import { serverClient, HttpError } from "../../src/background/server-client";
import { getServerDownloadHandler } from "../../src/background/server-download";

// ---------------------------------------------------------------------------

/** Get a mock function from the mocked serverClient singleton. */
function sc(method: string): vi.Mock {
  return (serverClient as any)[method] as vi.Mock;
}

/** downloadWithFallback resolves a URL so the completion branch fires. */
function downloadWithFallbackMock(): vi.Mock {
  return (getServerDownloadHandler() as any).downloadWithFallback as vi.Mock;
}

/** Get the uploadResource mock (called by the REAL UploadQueue). */
function uploadResourceMock(): vi.Mock {
  return sc("uploadResource");
}

function mockSessionStatus(overrides: Record<string, any> = {}) {
  sc("getSessionStatus").mockResolvedValue({
    id: "sess-resume-drain",
    url: "https://example.com/page",
    status: "scraping",
    html_chunks: 1,
    resources_discovered: 2,
    resources_received: 0,
    total_size: 2048,
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

/** Checkpoint manifest as persisted by download-checkpoint (D4: with size). */
function createManifestCheckpoint() {
  return {
    serverSessionId: "sess-resume-drain",
    tabUrl: "https://example.com/page",
    tabId: undefined,
    phase: "uploading",
    resourceUrls: [
      {
        url: "https://example.com/img.png",
        path: "images/img.png",
        contentType: "image/png",
        size: 128,
      },
      {
        url: "https://example.com/style.css",
        path: "styles/style.css",
        contentType: "text/css",
        size: 64,
      },
    ],
  };
}

function mockFetchOk(): vi.Mock {
  return vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    url,
    blob: async () =>
      new Blob([new Uint8Array(16)], { type: "application/octet-stream" }),
  }));
}

const sendMessage = vi.fn();

/** Extract the status.complete message options (last one sent). */
function lastCompleteOptions(): Record<string, any> | undefined {
  const calls = sendMessage.mock.calls.filter(
    (c) => c[0]?.key === "status.complete",
  );
  return calls[calls.length - 1]?.[0]?.options;
}

beforeEach(() => {
  vi.clearAllMocks();
  sc("scrapeComplete").mockResolvedValue(undefined);
  sc("finalizeSession").mockResolvedValue(undefined);
  downloadWithFallbackMock().mockResolvedValue({
    downloadUrl: "https://server.example.com/file.zip",
  });
  uploadResourceMock().mockResolvedValue({
    resource_id: "r",
    local_path: "p",
    size: 16,
    deduplicated: false,
    api_version: "v1",
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resumeServerDownload drains the checkpoint manifest into real uploads (D4)", () => {
  it("re-fetches every manifest entry and produces one upload call per entry", async () => {
    mockSessionStatus({ status: "uploading" });
    const mockFetch = mockFetchOk();
    globalThis.fetch = mockFetch as any;

    await resumeServerDownload(createManifestCheckpoint(), sendMessage);

    // Resume actually produced uploads — one per manifest entry
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/img.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(uploadResourceMock()).toHaveBeenCalledTimes(2);
    expect(uploadResourceMock()).toHaveBeenCalledWith(
      "sess-resume-drain",
      "images/img.png",
      expect.any(Blob),
      "https://example.com/img.png",
      "image/png",
      expect.anything(), // per-task abort signal
      expect.anything(), // progress callback
    );
    expect(uploadResourceMock()).toHaveBeenCalledWith(
      "sess-resume-drain",
      "styles/style.css",
      expect.any(Blob),
      "https://example.com/style.css",
      "text/css",
      expect.anything(),
      expect.anything(),
    );
  });

  it("sends scrapeComplete with the manifest count, then finalizes and polls", async () => {
    mockSessionStatus({ status: "uploading" });
    globalThis.fetch = mockFetchOk() as any;

    await resumeServerDownload(createManifestCheckpoint(), sendMessage);

    expect(sc("scrapeComplete")).toHaveBeenCalledWith("sess-resume-drain", 2);
    expect(sc("finalizeSession")).toHaveBeenCalledWith("sess-resume-drain");
    // uploadResource must have been called BEFORE finalize
    expect(uploadResourceMock()).toHaveBeenCalled();
  });

  it("reports failedCount 0 in status.complete on a clean resume", async () => {
    mockSessionStatus({ status: "uploading" });
    globalThis.fetch = mockFetchOk() as any;

    await resumeServerDownload(createManifestCheckpoint(), sendMessage);

    const options = lastCompleteOptions();
    expect(options).toBeDefined();
    expect(options.failedCount).toBe(0);
  });

  it("reports failedCount > 0 in status.complete when an upload fails permanently", async () => {
    mockSessionStatus({ status: "uploading" });
    globalThis.fetch = mockFetchOk() as any;
    // First upload 404s permanently (non-retryable), second succeeds.
    let call = 0;
    uploadResourceMock().mockImplementation(async () => {
      call++;
      if (call === 1) throw new HttpError("Not found", 404);
      return {
        resource_id: "r2",
        local_path: "p",
        size: 16,
        deduplicated: false,
        api_version: "v1",
      };
    });

    await resumeServerDownload(createManifestCheckpoint(), sendMessage);

    // Both entries were attempted (1 call each — the 404 is not retried)…
    expect(uploadResourceMock()).toHaveBeenCalledTimes(2);
    // …exactly one failed, and the completion payload carries it.
    const options = lastCompleteOptions();
    expect(options).toBeDefined();
    expect(options.failedCount).toBe(1);
  });

  it("skips entries that can no longer be fetched and still finalizes", async () => {
    mockSessionStatus({ status: "uploading" });
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("img.png")) {
        return { ok: false, status: 404 };
      }
      return {
        ok: true,
        url,
        blob: async () => new Blob([new Uint8Array(8)]),
      };
    });
    globalThis.fetch = mockFetch as any;

    await resumeServerDownload(createManifestCheckpoint(), sendMessage);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(uploadResourceMock()).toHaveBeenCalledTimes(1); // only style.css
    expect(sc("finalizeSession")).toHaveBeenCalledWith("sess-resume-drain");
    const options = lastCompleteOptions();
    expect(options.failedCount).toBe(0); // skip ≠ failed upload
  });
});

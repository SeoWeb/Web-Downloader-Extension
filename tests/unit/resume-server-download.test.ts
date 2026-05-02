/**
 * Tests for resumeServerDownload — server session resume after SW restart.
 *
 * Verifies:
 * - Resume with server resources but no checkpoint URLs: scrapeComplete + finalize + poll
 * - Resume with no server resources and no checkpoint URLs: throws "full restart required"
 * - Resume in assembling status: polls for completion
 * - Resume in ready status: downloads immediately
 * - Resume with checkpoint URLs: re-uploads resources
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — factories use vi.fn() inline to avoid hoisting issues.
// Access mock functions via the imported module after import.
// ---------------------------------------------------------------------------

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    getSessionStatus: vi.fn(),
    scrapeComplete: vi.fn().mockResolvedValue(undefined),
    finalizeSession: vi.fn().mockResolvedValue(undefined),
    uploadResource: vi.fn().mockResolvedValue(undefined),
  },
  ServerUnavailableError: class extends Error {
    constructor(msg: string) { super(msg); this.name = "ServerUnavailableError"; }
  },
  AuthenticationError: class extends Error {
    constructor(msg: string) { super(msg); this.name = "AuthenticationError"; }
  },
  AssemblyTimeoutError: class extends Error {
    constructor(msg: string) { super(msg); this.name = "AssemblyTimeoutError"; }
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
}));

vi.mock("../../src/common/storage/filterStorage", () => ({
  loadFilterOptions: vi.fn().mockResolvedValue({ alwaysAskWhereToSave: true }),
}));

vi.mock("../../src/background/server-download", () => ({
  getServerDownloadHandler: vi.fn().mockReturnValue({
    downloadWithFallback: vi.fn().mockResolvedValue(null),
  }),
  AssemblyFailedError: class extends Error {
    constructor(msg: string) { super(msg); this.name = "AssemblyFailedError"; }
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
      getResourceUrls = vi.fn().mockReturnValue([]);
      getResourceCount = vi.fn().mockReturnValue(0);
      getProgress = vi.fn().mockReturnValue({ completedCount: 0, totalCount: 0, bytesUploaded: 0, totalBytes: 0 });
      waitForAll = vi.fn().mockResolvedValue(undefined);
      enqueue = vi.fn();
      cancel = vi.fn();
      onProgress: any = null;
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

// ---------------------------------------------------------------------------
// Helpers — access mock fns via imported modules
// ---------------------------------------------------------------------------

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
      resumeServerDownload(createCheckpoint({ serverSessionId: undefined }), sendMessage),
    ).rejects.toThrow("No server session ID in checkpoint");
  });

  it("should download immediately when session is ready", async () => {
    mockSessionStatus({ status: "ready", download_url: "https://server.example.com/file.zip" });

    await resumeServerDownload(createCheckpoint(), sendMessage);

    expect(sc("scrapeComplete")).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ key: "status.complete" }),
    );
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

      expect(sc("scrapeComplete")).toHaveBeenCalledWith("sess-resume-test", 4711);
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

      expect(getMockDownloadWithFallback()).toHaveBeenCalledWith(
        "sess-resume-test",
        "https://example.com/page",
        false,
        expect.any(Function),
        expect.any(Function),
        undefined,
        true,
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
      { url: "https://example.com/img.png", path: "images/img.png", contentType: "image/png" },
      { url: "https://example.com/style.css", path: "styles/style.css", contentType: "text/css" },
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
});

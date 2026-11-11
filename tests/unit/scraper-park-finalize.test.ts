/**
 * Download-core-level tests for the parked-download flow (multipage-download-
 * fixes D2 / tasks 4.4–4.5).
 *
 * Verifies:
 * - finalizeParkedDownload (stop-from-park): best-effort scrape-complete with
 *   the server's received count, finalize, and delivery of the PARTIAL
 *   archive; an already-ready session is delivered as-is; a failed/expired
 *   session throws (definitive),
 * - resumeFromParkedScrape: re-spawns LinkedPageScraper.fromSnapshot with the
 *   persisted snapshot (same session, remaining queues), runs processQueue,
 *   and continues through scrapeComplete → finalize → assembly poll.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resumeFromParkedScrape,
  finalizeParkedDownload,
} from "../../src/background/download-core";
import { serverClient } from "../../src/background/server-client";
import { LinkedPageScraper } from "../../src/background/linked-page-scraper";
import { getServerDownloadHandler } from "../../src/background/server-download";
import type { LinkedScraperSnapshot } from "../../src/background/scraper-snapshot";

// ---------------------------------------------------------------------------
// Mocks (resume-server-download.test.ts pattern)
// ---------------------------------------------------------------------------

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    baseUrl: "https://server.example.com",
    getSessionStatus: vi.fn(),
    scrapeComplete: vi.fn().mockResolvedValue(undefined),
    finalizeSession: vi.fn().mockResolvedValue(undefined),
    uploadResource: vi.fn(),
    uploadContent: vi.fn(),
    uploadPageContent: vi.fn(),
  },
  assertSecureBaseUrl: vi.fn(),
  upgradeInsecureServerUrl: vi.fn((url: string) => url),
  ServerUnavailableError: class extends Error {},
  AuthenticationError: class extends Error {},
  AssemblyTimeoutError: class extends Error {},
}));

vi.mock("../../src/background/download-state", () => ({
  setDownloadAbortController: vi.fn(),
  getDownloadAbortController: vi.fn().mockReturnValue(null),
  createKeepalivePort: vi.fn(),
  disconnectKeepalivePort: vi.fn(),
  downloadId: "download-test",
  createDownloadContext: vi.fn((params: any) => ({
    downloadId: "download-test",
    tabId: params?.tabId,
    tabUrl: params?.tabUrl ?? "",
    serverSessionId: params?.serverSessionId,
    imageFilenameMap: new Map(),
    dedupKeys: new Set(),
    abortController: params?.abortController,
    assemblyAbortController: new AbortController(),
    uploadQueue: params?.uploadQueue,
  })),
  setTabDownloadActive: vi.fn(),
  setTabDownloadComplete: vi.fn(),
  isAnyDownloadInProgress: vi.fn().mockReturnValue(false),
  isTabDownloadInProgress: vi.fn().mockReturnValue(false),
  markSessionLive: vi.fn(),
  markSessionNotLive: vi.fn(),
  isSessionLive: vi.fn().mockReturnValue(false),
  setSessionUploadQueue: vi.fn(),
  setSessionPhase: vi.fn(),
  setSessionLastError: vi.fn(),
}));

vi.mock("../../src/common/storage/filterStorage", () => ({
  loadFilterOptions: vi.fn().mockResolvedValue({ alwaysAskWhereToSave: true }),
}));

vi.mock("../../src/background/server-download", () => ({
  getServerDownloadHandler: vi.fn().mockReturnValue({
    downloadWithFallback: vi.fn().mockResolvedValue({
      downloadUrl: "https://server.example.com/artifact.zip",
    }),
  }),
  AssemblyFailedError: class extends Error {},
}));

/** The downloadWithFallback mock inside the handler above. */
function handlerDownloadWithFallback(): any {
  return (getServerDownloadHandler() as any).downloadWithFallback;
}

vi.mock("../../src/background/download-checkpoint", () => ({
  writeCheckpoint: vi.fn(),
  updateCheckpointPhase: vi.fn(),
  updateCheckpointResourceUrls: vi.fn(),
  clearCheckpoint: vi.fn(),
  readCheckpoint: vi.fn().mockResolvedValue(null),
  pauseCheckpoint: vi.fn(),
  restoreCheckpointPhase: vi.fn(),
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

vi.mock("../../src/background/upload-queue", () => {
  return {
    UploadQueue: class {
      failedCount = 0;
      getResourceUrls = vi.fn().mockReturnValue([]);
      getResourceCount = vi.fn().mockReturnValue(2);
      getProgress = vi.fn(function (this: any) {
        return {
          completedCount: 0,
          failedCount: this.failedCount,
          totalCount: 2,
          bytesUploaded: 0,
          totalBytes: 0,
        };
      });
      waitForAll = vi.fn().mockResolvedValue(undefined);
      enqueue = vi.fn().mockResolvedValue("task-0");
      cancel = vi.fn();
      onProgress: any = null;
    },
  };
});

// ---------------------------------------------------------------------------

const SESSION_ID = "sess-parked";
const TAB_ID = 7;
const TAB_URL = "https://example.com/start";

function makeSnapshot(
  overrides: Partial<LinkedScraperSnapshot> = {},
): LinkedScraperSnapshot {
  return {
    version: 1,
    serverSessionId: SESSION_ID,
    tabId: TAB_ID,
    tabUrl: TAB_URL,
    phase: "internal",
    internalQueue: [
      { url: "https://example.com/next", depth: 1, parentUrl: TAB_URL },
    ],
    externalQueue: [],
    visitedUrls: ["https://example.com/done"],
    successCount: 1,
    failCount: 0,
    options: {
      maxPages: 10,
      delayBetweenPages: 0,
      includeExternal: false,
      pageTimeout: 30000,
      downloadImages: true,
      downloadAssets: true,
      downloadDocuments: true,
      extractText: true,
    },
    previousCheckpointPhase: "scraping",
    timestamp: Date.now(),
    ...overrides,
  };
}

const sendMessage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  handlerDownloadWithFallback().mockResolvedValue({
    downloadUrl: "https://server.example.com/artifact.zip",
  });
});

// ---------------------------------------------------------------------------
// finalizeParkedDownload — stop-from-park delivers the partial
// ---------------------------------------------------------------------------

describe("finalizeParkedDownload — stop-from-park delivers the partial (task 4.5)", () => {
  it("scrape-completes with the server's received count, finalizes, and delivers the partial", async () => {
    vi.mocked(serverClient.getSessionStatus as any).mockResolvedValue({
      status: "scraping",
      resources_received: 5,
    });

    await finalizeParkedDownload(
      { serverSessionId: SESSION_ID, tabId: TAB_ID, tabUrl: TAB_URL },
      sendMessage,
    );

    expect(serverClient.scrapeComplete).toHaveBeenCalledWith(SESSION_ID, 5);
    expect(serverClient.finalizeSession).toHaveBeenCalledWith(SESSION_ID);
    expect(getServerDownloadHandler).toHaveBeenCalled();
    // The partial artifact was delivered to the panel
    const pushed = sendMessage.mock.calls.map((c) => c[0]);
    expect(pushed.some((m: any) => m?.key === "status.finalizingPartial")).toBe(
      true,
    );
    expect(
      pushed.some(
        (m: any) =>
          m?.key === "status.complete" &&
          m?.options?.downloadUrl === "https://server.example.com/artifact.zip",
      ),
    ).toBe(true);
  });

  it("an already-ready session is delivered as-is (no finalize)", async () => {
    vi.mocked(serverClient.getSessionStatus as any).mockResolvedValue({
      status: "ready",
      download_url: "https://server.example.com/artifact.zip",
    });

    await finalizeParkedDownload(
      { serverSessionId: SESSION_ID, tabId: TAB_ID, tabUrl: TAB_URL },
      sendMessage,
    );

    expect(serverClient.finalizeSession).not.toHaveBeenCalled();
    const pushed = sendMessage.mock.calls.map((c) => c[0]);
    expect(pushed.some((m: any) => m?.key === "status.complete")).toBe(true);
  });

  it("a failed/expired session throws (definitive — nothing to finalize)", async () => {
    vi.mocked(serverClient.getSessionStatus as any).mockResolvedValue({
      status: "expired",
    });

    await expect(
      finalizeParkedDownload(
        { serverSessionId: SESSION_ID, tabId: TAB_ID, tabUrl: TAB_URL },
        sendMessage,
      ),
    ).rejects.toThrow(/expired and cannot be finalized/);
    expect(serverClient.finalizeSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resumeFromParkedScrape — re-spawn seeded from the snapshot
// ---------------------------------------------------------------------------

describe("resumeFromParkedScrape — re-spawn from snapshot (task 4.5)", () => {
  it("re-spawns LinkedPageScraper.fromSnapshot, runs the queue, and finishes through finalize", async () => {
    vi.mocked(serverClient.getSessionStatus as any).mockResolvedValue({
      status: "scraping",
      resources_received: 3,
    });
    const processQueue = vi.fn().mockResolvedValue("");
    const reacquireTab = vi.fn(async (tabId: number) => tabId);
    (LinkedPageScraper.fromSnapshot as any) = vi
      .fn()
      .mockImplementation(() => ({
        processQueue,
        reacquireTab,
      }));

    const snapshot = makeSnapshot();
    await resumeFromParkedScrape(snapshot, sendMessage);

    // Same unfinalized session, same frozen state
    expect(LinkedPageScraper.fromSnapshot).toHaveBeenCalledWith(
      snapshot,
      expect.anything(),
    );
    // A tab was re-acquired before the scrape continued (task 4.2)
    expect(reacquireTab).toHaveBeenCalledWith(TAB_ID);
    expect(processQueue).toHaveBeenCalledWith(
      TAB_ID,
      expect.objectContaining({ setSessionId: expect.any(Function) }),
      sendMessage,
      expect.objectContaining({ tabId: TAB_ID }),
    );
    // Tail: scrapeComplete → finalize → assembly poll delivered the artifact
    expect(serverClient.scrapeComplete).toHaveBeenCalledWith(SESSION_ID, 2);
    expect(serverClient.finalizeSession).toHaveBeenCalledWith(SESSION_ID);
    const pushed = sendMessage.mock.calls.map((c) => c[0]);
    expect(
      pushed.some(
        (m: any) =>
          m?.key === "status.complete" &&
          m?.options?.serverSessionId === SESSION_ID,
      ),
    ).toBe(true);
  });

  it("throws definitively when the parked session expired (no crash, clear error)", async () => {
    vi.mocked(serverClient.getSessionStatus as any).mockResolvedValue({
      status: "failed",
    });

    await expect(
      resumeFromParkedScrape(makeSnapshot(), sendMessage),
    ).rejects.toThrow(/failed and cannot be resumed/);
    expect(LinkedPageScraper.fromSnapshot).not.toHaveBeenCalled();
  });
});

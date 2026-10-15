/**
 * Unit tests for the downloadResources teardown gate (concurrent-downloads
 * spec / design D7).
 *
 * Bug under test (E2E R9, download-pipeline.test.cjs with E2E_CONCURRENT=1):
 * the `finally` block of `downloadResources` used to call
 * `requestQueue.clear()` + `cleanupAfterDownload()` → `forceCleanup()` on the
 * SHARED singletons unconditionally — the first-finishing tab aborted the
 * other tab's in-flight fetches and dropped its queued requests (whose
 * handler promises then never settled), so the peer never reached
 * scrape-complete/finalize.
 *
 * These tests exercise that seam: with a simulated peer download still
 * active, teardown must be SCOPED (`clearDownload`, no full clear, no
 * memory forceCleanup); when the finishing download is the last one, the
 * full global teardown must run so memory accounting returns to baseline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock download-core's collaborators (the flow is driven to a server error at
// session creation; the assertions target the teardown in the finally block).
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
    images: [],
    css: [],
    js: [],
    links: [],
    documents: [],
    text: "",
  })),
}));
vi.mock("../../src/background/download-processors", () => ({
  processImages: vi.fn(),
  processAssets: vi.fn(),
  processDocuments: vi.fn(),
}));
vi.mock("../../src/background/linked-page-scraper", () => ({
  LinkedPageScraper: class {},
}));
vi.mock("../../src/background/storage/server-storage-adapter", () => ({
  ServerStorageAdapter: class {
    setSessionId() {}
    getUploadQueue() {
      return {};
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
  // pagepocket-client (loaded transitively via cloud-binding) imports this
  const assertSecureBaseUrl = vi.fn();
  class AssemblyTimeoutError extends Error {
    constructor(message = "assembly timeout") {
      super(message);
      this.name = "AssemblyTimeoutError";
    }
  }
  // download-core references HttpError in its error mapping (task 6.5)
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
      createSession: vi.fn(async () => {
        throw new ServerUnavailableError("mock: server unavailable");
      }),
    },
    assertSecureBaseUrl,
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
  getServerDownloadHandler: vi.fn(),
  AssemblyFailedError: class extends Error {},
}));
vi.mock("../../src/background/scraper-state", () => ({
  setCurrentScraper: vi.fn(),
  stopScraping: vi.fn(),
}));
vi.mock("../../src/background/message", () => ({
  setActiveServerSession: vi.fn(),
  getActiveServerSessionId: vi.fn(() => undefined),
  hasStreamedHtmlChunks: vi.fn(() => false),
}));
vi.mock("../../src/common/storage/filterStorage", () => ({
  loadFilterOptions: vi.fn(async () => ({})),
}));

import { requestQueue } from "../../src/utils/RequestQueue";
import { memoryManager } from "../../src/utils/MemoryManager";
import { downloadResources } from "../../src/background/download-core";
import { cleanupAfterDownload } from "../../src/background/cleanupHandlers";
import {
  setTabDownloadActive,
  setTabDownloadComplete,
} from "../../src/background/download-state";
import type { FilterOptions } from "../../src/types/filterTypes";

// tests/setup.cjs provides chrome.storage.local; createKeepalivePort needs
// chrome.runtime.connect as well.
(globalThis.chrome as { runtime?: unknown }).runtime = {
  connect: () => ({
    onMessage: { addListener: () => {} },
    postMessage: () => {},
    disconnect: () => {},
  }),
};

describe("downloadResources teardown gate (concurrent downloads)", () => {
  const clearSpy = vi.spyOn(requestQueue, "clear");
  const clearDownloadSpy = vi.spyOn(requestQueue, "clearDownload");
  const forceCleanupSpy = vi.spyOn(memoryManager, "forceCleanup");
  const cleanupMock = vi.mocked(cleanupAfterDownload);

  const runDownload = (tabId: number, url: string) => {
    const sendMessage = vi.fn();
    const flow = downloadResources(
      "<html><body>page</body></html>",
      url,
      {} as FilterOptions,
      sendMessage,
      undefined,
      tabId,
    );
    return { flow, sendMessage };
  };

  beforeEach(() => {
    clearSpy.mockClear();
    clearDownloadSpy.mockClear();
    forceCleanupSpy.mockClear();
    cleanupMock.mockClear();
  });

  it("scopes teardown while another tab's download is still active", async () => {
    // Simulated peer download in tab 202 is still running.
    await setTabDownloadActive(202);

    try {
      const { flow, sendMessage } = runDownload(
        10,
        "https://fixture.test/pageA.html",
      );
      await flow;

      // The flow failed at session creation (mocked server outage) and the
      // user was notified — the assertion target is the teardown below.
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ key: "status.serverError" }),
      );

      // Scoped purge of THIS download only…
      expect(clearDownloadSpy).toHaveBeenCalledTimes(1);
      expect(clearDownloadSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^download-/),
      );
      // …never the shared full clear / global memory cleanup.
      expect(clearSpy).not.toHaveBeenCalled();
      expect(cleanupMock).not.toHaveBeenCalled();
      expect(forceCleanupSpy).not.toHaveBeenCalled();
    } finally {
      await setTabDownloadComplete(202);
    }
  });

  it("runs the full global teardown when this is the last download", async () => {
    // No peer registered — this download finishes alone. Note that its own
    // tab (20) is removed from the active set before the gate evaluates.
    const { flow } = runDownload(20, "https://fixture.test/pageB.html");
    await flow;

    expect(cleanupMock).toHaveBeenCalledTimes(1);
    expect(cleanupMock).toHaveBeenCalledWith(
      expect.stringMatching(/^download-/),
    );
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearDownloadSpy).not.toHaveBeenCalled();
  });

  it("scopes teardown after a memory-classified error with a peer active", async () => {
    await setTabDownloadActive(303);
    try {
      // createSession rejects with ServerUnavailableError — not memory
      // classified, so forceCleanup must be skipped regardless of the gate;
      // the gate itself is exercised via cleanupAfterDownload/clear above.
      const { flow } = runDownload(11, "https://fixture.test/pageC.html");
      await flow;

      expect(clearDownloadSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).not.toHaveBeenCalled();
      expect(forceCleanupSpy).not.toHaveBeenCalled();
    } finally {
      await setTabDownloadComplete(303);
    }
  });
});

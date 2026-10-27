/**
 * Unit tests for the linked-pages GATE in download-core (scraping rework).
 *
 * The legacy simple-fetch mode was removed: crawling linked pages now
 * ALWAYS runs the in-tab LinkedPageScraper, gated ONLY by
 * `downloadLinksFullScraping` (+ tabId). The legacy `downloadLinks` storage
 * key no longer gates anything.
 *
 * Under test:
 * - `downloadLinksFullScraping: true` (+ `downloadLinks: false`) → the
 *   scraper is constructed, the discovered links are queued, and NO raw
 *   linked-page fetch happens;
 * - legacy stored state `downloadLinks: true, downloadLinksFullScraping:
 *   false` → no scraper, no linked fetch (the old branch is gone), and the
 *   download still completes normally.
 *
 * Mocking mirrors download-core-teardown.test.ts, but the flow is driven
 * through a SUCCESSFUL session all the way past the linked-pages gate.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted state shared with the module mocks
// ---------------------------------------------------------------------------

const gate = vi.hoisted(() => {
  const fakeQueue = {
    onProgress: null as unknown,
    onSessionFull: null as unknown,
    cancel: () => {},
    getResourceUrls: () => [] as string[],
    getResourceCount: () => 0,
    getProgress: () => ({ totalCount: 0, completedCount: 0, failedCount: 0 }),
    waitForAll: async () => {},
    isSessionFull: () => false,
  };
  return {
    /** LinkedPageScraper instances constructed by download-core. */
    scrapers: [] as Array<any>,
    /** Links returned by the mocked getResources(). */
    links: [] as string[],
    /** Every global fetch attempt (must stay empty in both cases). */
    fetchCalls: [] as string[],
    fakeQueue,
  };
});

// ---------------------------------------------------------------------------
// Mocks — download-core's collaborators (same set as
// download-core-teardown.test.ts, driven to SUCCESS instead of failure)
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
    links: gate.links,
    documents: [],
    text: "",
  })),
}));
vi.mock("../../src/background/download-processors", () => ({
  processImages: vi.fn(),
  processAssets: vi.fn(),
  processDocuments: vi.fn(),
  mergeFilenameMaps: vi.fn(() => new Map()),
}));
vi.mock("../../src/background/linked-page-scraper", () => ({
  LinkedPageScraper: class {
    ctorArgs: unknown[];
    queued: Array<Record<string, unknown>> = [];
    extractText: unknown;
    constructor(...args: unknown[]) {
      gate.scrapers.push(this);
      this.ctorArgs = args;
    }
    setExtractText(value: unknown) {
      this.extractText = value;
    }
    async addToQueue(task: Record<string, unknown>) {
      this.queued.push(task);
    }
    async processQueue() {
      return null;
    }
  },
}));
vi.mock("../../src/background/storage/server-storage-adapter", () => ({
  ServerStorageAdapter: class {
    setSessionId() {}
    getUploadQueue() {
      return gate.fakeQueue;
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
      createSession: vi.fn(async () => "session-gate-1"),
      uploadHtmlChunk: vi.fn(async () => {}),
      uploadFilenameMap: vi.fn(async () => {}),
      uploadContent: vi.fn(async () => {}),
      scrapeComplete: vi.fn(async () => {}),
      finalizeSession: vi.fn(async () => {}),
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
  getServerDownloadHandler: vi.fn(() => ({
    downloadWithFallback: vi.fn(async () => ({})),
  })),
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

import { downloadResources } from "../../src/background/download-core";
import { hasStreamedHtmlChunks } from "../../src/background/message";
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

// The removed simple-fetch branch was the ONLY consumer of a bare global
// fetch here (server client / queue are mocked) — any fetch attempt means
// deleted code came back.
const fetchSpy = vi
  .spyOn(globalThis, "fetch")
  .mockImplementation(async (input: unknown) => {
    gate.fetchCalls.push(String(input));
    throw new Error(`unexpected fetch: ${String(input)}`);
  });

afterAll(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function downloadOptions(
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

const TAB_ID = 42;

async function runDownload(options: FilterOptions) {
  const sendMessage = vi.fn();
  await downloadResources(
    "<html><body>page</body></html>",
    "https://fixture.test/page.html",
    options,
    sendMessage,
    undefined,
    TAB_ID,
  );
  return sendMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("download-core linked-pages gate", () => {
  beforeEach(() => {
    gate.scrapers.length = 0;
    gate.fetchCalls.length = 0;
    gate.links = [];
    vi.clearAllMocks();
  });

  it("runs the linked-page scraper when only downloadLinksFullScraping is set", async () => {
    gate.links = ["https://fixture.test/sub.html", "https://[invalid"];

    const sendMessage = await runDownload(
      downloadOptions({
        // Legacy key OFF — the scraper must engage WITHOUT it
        downloadLinks: false,
        downloadLinksFullScraping: true,
        linkedPagesMaxCount: 200,
        linkedPagesDelay: 500,
        linkedPagesIncludeExternal: false,
      }),
    );

    // Scraper constructed exactly once, wired to the session
    expect(gate.scrapers).toHaveLength(1);
    const scraper = gate.scrapers[0];
    expect(scraper.ctorArgs[1]).toEqual(
      expect.objectContaining({
        maxPages: 200,
        delayBetweenPages: 500,
        includeExternal: false,
        serverSessionId: "session-gate-1",
      }),
    );
    expect(scraper.extractText).toBe(false);

    // Valid links queued (absolute), invalid ones skipped
    expect(scraper.queued).toHaveLength(1);
    expect(scraper.queued[0]).toEqual(
      expect.objectContaining({
        url: "https://fixture.test/sub.html",
        depth: 1,
        parentUrl: "https://fixture.test/page.html",
      }),
    );

    // User messaging + flow completion past the gate
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ key: "status.scrapingLinkedPages" }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ key: "status.complete" }),
    );
    expect(serverClient.scrapeComplete).toHaveBeenCalledWith(
      "session-gate-1",
      0,
      0,
    );

    // No raw linked-page fetch — the simple-fetch branch is gone
    expect(gate.fetchCalls).toEqual([]);
  });

  it("ignores the legacy downloadLinks key: no scraper, no linked fetch", async () => {
    gate.links = ["https://fixture.test/sub.html"];

    const sendMessage = await runDownload(
      downloadOptions({
        downloadLinks: true, // legacy stored preference
        downloadLinksFullScraping: false,
      }),
    );

    expect(gate.scrapers).toHaveLength(0);

    // Neither the removed simple-fetch messages nor the scraper message
    const keys = sendMessage.mock.calls.map(
      (call) => (call[0] as { key: string }).key,
    );
    expect(keys).not.toContain("status.downloadingLinks");
    expect(keys).not.toContain("status.linksDownloaded");
    expect(keys).not.toContain("status.scrapingLinkedPages");

    // The download itself still completes normally
    expect(keys).toContain("status.complete");
    expect(serverClient.scrapeComplete).toHaveBeenCalledWith(
      "session-gate-1",
      0,
      0,
    );

    // And nothing ever hits a bare fetch
    expect(gate.fetchCalls).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // START_DOWNLOAD lastSnapshot policy: skip the final HTML re-upload
  // when chunks were streamed during scrolling; upload chunk 0 otherwise.
  // ---------------------------------------------------------------------
  it("uploads the initial HTML chunk (index 0) when nothing was streamed", async () => {
    vi.mocked(hasStreamedHtmlChunks).mockReturnValue(false);

    const sendMessage = await runDownload(downloadOptions());

    expect(serverClient.uploadHtmlChunk).toHaveBeenCalledTimes(1);
    expect(serverClient.uploadHtmlChunk).toHaveBeenCalledWith(
      "session-gate-1",
      "<html><body>page</body></html>",
      0,
      "main",
    );
    const keys = sendMessage.mock.calls.map(
      (call) => (call[0] as { key: string }).key,
    );
    expect(keys).toContain("status.uploadingHtml");
    expect(keys).toContain("status.htmlUploaded");
  });

  it("skips the HTML re-upload when chunks were streamed during scrolling", async () => {
    // The sidepanel streams every scroll step (including the final settled
    // DOM) and START_DOWNLOAD receives that same last chunk's HTML — a
    // re-upload would duplicate it (and at hardcoded index 0 it would
    // overwrite the skeleton-initializing chunk server-side).
    vi.mocked(hasStreamedHtmlChunks).mockReturnValue(true);

    const sendMessage = await runDownload(downloadOptions());

    expect(serverClient.uploadHtmlChunk).not.toHaveBeenCalled();
    const keys = sendMessage.mock.calls.map(
      (call) => (call[0] as { key: string }).key,
    );
    expect(keys).not.toContain("status.uploadingHtml");
    // The download still completes normally.
    expect(keys).toContain("status.complete");
  });
});

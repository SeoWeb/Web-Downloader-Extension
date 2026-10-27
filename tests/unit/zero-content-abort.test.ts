/**
 * (Fix C — zero-content abort) Tests.
 *
 * Incident: pressing download while the page was still hydrating produced
 * instant "successful" 0-resource downloads — an empty server session was
 * finalized and pushed an empty page.
 *
 * Under test:
 * - isEmptyDownload() — the pure decision (which option/extracted-content
 *   combinations count as empty),
 * - the MAIN-flow wiring: an empty download is aborted BEFORE
 *   scrapeComplete/finalize with the user-facing warning
 *   (status.noDownloadableContent), and no HTML chunk is uploaded;
 * - a download WITH content still completes normally.
 *
 * Mocking mirrors download-core-linked-pages-gate.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — download-core's collaborators
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
  processImages: vi.fn(async () => new Map()),
  processAssets: vi.fn(async () => new Map()),
  processDocuments: vi.fn(async () => new Map()),
  mergeFilenameMaps: vi.fn(() => new Map()),
}));
vi.mock("../../src/background/linked-page-scraper", () => ({
  LinkedPageScraper: class {},
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
        }),
        waitForAll: async () => {},
        isSessionFull: () => false,
      };
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
  const assertSecureBaseUrl = vi.fn();
  class AssemblyTimeoutError extends Error {
    constructor(message = "assembly timeout") {
      super(message);
      this.name = "AssemblyTimeoutError";
    }
  }
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
      createSession: vi.fn(async () => "session-empty-1"),
      uploadHtmlChunk: vi.fn(async () => {}),
      uploadFilenameMap: vi.fn(async () => {}),
      uploadContent: vi.fn(async () => {}),
      scrapeComplete: vi.fn(async () => {}),
      finalizeSession: vi.fn(async () => {}),
      getSessionStatus: vi.fn(async () => ({})),
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

// Spy on the liveness tracking (Fix D.1 wiring is verified here too).
vi.mock("../../src/background/download-state", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/background/download-state")
    >();
  return {
    ...actual,
    markSessionLive: vi.fn(actual.markSessionLive),
    markSessionNotLive: vi.fn(actual.markSessionNotLive),
  };
});

import {
  downloadResources,
  isEmptyDownload,
} from "../../src/background/download-core";
import { getResources } from "../../src/background/resources";
import { serverClient } from "../../src/background/server-client";
import { hasStreamedHtmlChunks } from "../../src/background/message";
import {
  markSessionLive,
  markSessionNotLive,
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

function downloadOptions(
  overrides: Partial<FilterOptions> = {},
): FilterOptions {
  return {
    downloadHTML: true,
    downloadImages: true,
    downloadLinks: false,
    downloadAssets: true,
    downloadContentAsText: false,
    downloadDocuments: true,
    singleFile: false,
    ...overrides,
  } as FilterOptions;
}

const TAB_ID = 77;

function mockResources(data: Partial<ReturnType<typeof getResources>>) {
  vi.mocked(getResources).mockReturnValue({
    images: [],
    css: [],
    js: [],
    links: [],
    documents: [],
    text: "",
    ...data,
  } as ReturnType<typeof getResources>);
}

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

beforeEach(() => {
  vi.clearAllMocks();
  mockResources({});
});

// ---------------------------------------------------------------------------
// isEmptyDownload — the pure decision
// ---------------------------------------------------------------------------

describe("isEmptyDownload (pure decision)", () => {
  it("is empty when everything is off and nothing was extracted", () => {
    expect(
      isEmptyDownload(
        downloadOptions({
          downloadHTML: false,
          downloadImages: false,
          downloadAssets: false,
          downloadDocuments: false,
        }),
        { css: [], js: [], documents: [], images: [], links: [], text: "" },
      ),
    ).toBe(true);
  });

  it("is NOT empty when the HTML output is enabled", () => {
    expect(
      isEmptyDownload(
        downloadOptions({
          downloadImages: false,
          downloadAssets: false,
          downloadDocuments: false,
        }),
        { css: [], js: [], documents: [], images: [], links: [], text: "" },
      ),
    ).toBe(false);
  });

  it("is NOT empty when resources would be uploaded", () => {
    const opts = downloadOptions({
      downloadHTML: false,
      downloadAssets: false,
      downloadDocuments: false,
    });
    expect(
      isEmptyDownload(opts, {
        css: [],
        js: [],
        documents: [],
        images: ["https://fixture.test/a.png"],
        links: [],
        text: "",
      }),
    ).toBe(false);
  });

  it("ignores discovered resources whose category is DISABLED", () => {
    // Images discovered but downloadImages off → they will NOT be uploaded.
    expect(
      isEmptyDownload(
        downloadOptions({
          downloadHTML: false,
          downloadImages: false,
          downloadAssets: false,
          downloadDocuments: false,
        }),
        {
          css: [],
          js: [],
          documents: [],
          images: ["https://fixture.test/a.png"],
          links: [],
          text: "",
        },
      ),
    ).toBe(true);
  });

  it("is NOT empty when a non-empty text document is produced", () => {
    expect(
      isEmptyDownload(
        downloadOptions({
          downloadHTML: false,
          downloadImages: false,
          downloadAssets: false,
          downloadDocuments: false,
          downloadContentAsText: true,
        }),
        {
          css: [],
          js: [],
          documents: [],
          images: [],
          links: [],
          text: "hello",
        },
      ),
    ).toBe(false);
  });

  it("IS empty when the text flag is on but the extracted text is blank", () => {
    expect(
      isEmptyDownload(
        downloadOptions({
          downloadHTML: false,
          downloadImages: false,
          downloadAssets: false,
          downloadDocuments: false,
          downloadContentAsText: true,
        }),
        {
          css: [],
          js: [],
          documents: [],
          images: [],
          links: [],
          text: "  \n ",
        },
      ),
    ).toBe(true);
  });

  it("is NOT empty when markdown conversion was requested", () => {
    expect(
      isEmptyDownload(
        downloadOptions({
          downloadHTML: false,
          downloadImages: false,
          downloadAssets: false,
          downloadDocuments: false,
          downloadContentAsMarkdown: true,
          downloadContentAsText: false,
        }),
        { css: [], js: [], documents: [], images: [], links: [], text: "" },
      ),
    ).toBe(false);
  });

  it("is NOT empty when full scraping has links to crawl", () => {
    expect(
      isEmptyDownload(
        downloadOptions({
          downloadHTML: false,
          downloadImages: false,
          downloadAssets: false,
          downloadDocuments: false,
          downloadLinksFullScraping: true,
        }),
        {
          css: [],
          js: [],
          documents: [],
          images: [],
          links: ["https://fixture.test/sub.html"],
          text: "",
        },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MAIN-flow wiring through downloadResources
// ---------------------------------------------------------------------------

describe("zero-content abort in downloadResources (main flow)", () => {
  it("aborts an empty download with the warning and never reaches scrapeComplete/finalize", async () => {
    const sendMessage = await runDownload(
      downloadOptions({
        downloadHTML: false,
        downloadImages: false,
        downloadAssets: false,
        downloadDocuments: false,
      }),
    );

    const keys = sendMessage.mock.calls.map(
      (call) => (call[0] as { key: string }).key,
    );

    // User-facing warning (Fix C surfacing path)
    expect(keys).toContain("status.noDownloadableContent");

    // Aborted BEFORE the scrape-complete/finalize pipeline
    expect(keys).not.toContain("status.sendingScrapeComplete");
    expect(keys).not.toContain("status.complete");
    expect(keys).not.toContain("status.finalizingServer");
    expect(serverClient.scrapeComplete).not.toHaveBeenCalled();
    expect(serverClient.finalizeSession).not.toHaveBeenCalled();

    // Aborted BEFORE the skeleton HTML chunk upload
    expect(serverClient.uploadHtmlChunk).not.toHaveBeenCalled();
    expect(keys).not.toContain("status.uploadingHtml");

    // Liveness was marked and cleared around the (aborted) flow — Fix D.1
    // (Round 9 — Fix B: markSessionLive now also carries the run's tab +
    // phase for the panel's CHECK_DOWNLOAD_LIVE snapshot.)
    expect(markSessionLive).toHaveBeenCalledWith("session-empty-1", {
      tabId: 77,
      phase: "uploading",
    });
    expect(markSessionNotLive).toHaveBeenCalledWith("session-empty-1");
  });

  it("still aborts when unmonitored resources exist but no output is enabled", async () => {
    // Resources were discovered, but every output flag is off → the session
    // would still be empty.
    mockResources({
      images: ["https://fixture.test/a.png"],
      css: ["https://fixture.test/style.css"],
    });

    const sendMessage = await runDownload(
      downloadOptions({
        downloadHTML: false,
        downloadImages: false,
        downloadAssets: false,
        downloadDocuments: false,
      }),
    );

    const keys = sendMessage.mock.calls.map(
      (call) => (call[0] as { key: string }).key,
    );
    expect(keys).toContain("status.noDownloadableContent");
    expect(serverClient.finalizeSession).not.toHaveBeenCalled();
  });

  it("proceeds normally when the download has content", async () => {
    mockResources({ images: ["https://fixture.test/a.png"] });

    const sendMessage = await runDownload(downloadOptions());

    const keys = sendMessage.mock.calls.map(
      (call) => (call[0] as { key: string }).key,
    );

    expect(keys).not.toContain("status.noDownloadableContent");
    expect(keys).toContain("status.uploadingHtml");
    expect(keys).toContain("status.complete");
    expect(serverClient.scrapeComplete).toHaveBeenCalled();
    expect(serverClient.finalizeSession).toHaveBeenCalled();
  });

  it("proceeds normally for a text-only download with non-empty text (HTML off)", async () => {
    mockResources({ text: "real page content" });

    const sendMessage = await runDownload(
      downloadOptions({
        downloadHTML: false,
        downloadImages: false,
        downloadAssets: false,
        downloadDocuments: false,
        downloadContentAsText: true,
      }),
    );

    const keys = sendMessage.mock.calls.map(
      (call) => (call[0] as { key: string }).key,
    );

    expect(keys).not.toContain("status.noDownloadableContent");
    expect(keys).toContain("status.complete");
  });

  it("does not re-upload the HTML chunk for streamed sessions when content exists", async () => {
    vi.mocked(hasStreamedHtmlChunks).mockReturnValue(true);
    mockResources({ images: ["https://fixture.test/a.png"] });

    await runDownload(downloadOptions());

    expect(serverClient.uploadHtmlChunk).not.toHaveBeenCalled();
    vi.mocked(hasStreamedHtmlChunks).mockReturnValue(false);
  });
});

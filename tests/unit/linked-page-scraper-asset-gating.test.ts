/**
 * Tests for linked-page asset gating (multipage-download-fixes task 1.2, design D1).
 *
 * Defect at HEAD: LinkedPageScraper.downloadAssets() fetches images/css/js/
 * documents on linked pages UNCONDITIONALLY, while the main page obeys the
 * per-category flags (download-core.ts:824-855). A text-only run therefore
 * fetches (and uploads) assets for every linked page even though the
 * press-time snapshot has every category flag off.
 *
 * The fix threads the normalized `downloadOptions` snapshot into the scraper
 * and gates downloadAssets() per category exactly like the main page:
 * - images   → downloadImages
 * - css/js   → downloadAssets
 * - documents→ downloadDocuments
 * with defaults true so constructions without the fields keep current
 * behavior (backward compat).
 *
 * Assertion seam: the fileHandlers module (addCssFiles/addJsFiles/
 * addImageFiles/addDocumentFiles) is the fetch/enqueue boundary — each
 * handler is what fetches the asset and enqueues it into the UploadQueue.
 * The same seam the existing linked-page-scraper tests mock. Storage
 * writes (storage.addFile) are asserted as a second layer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedPageScraper } from "../../src/background/linked-page-scraper";
import { AssetRegistry } from "../../src/background/asset-registry";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockChromeTabsGet = vi.fn();
const mockChromeTabsUpdate = vi.fn();
const mockChromeTabsOnUpdated = {
  addListener: vi.fn(),
  removeListener: vi.fn(),
};
const mockChromeScriptingExecuteScript = vi.fn();

Object.defineProperty(globalThis, "chrome", {
  value: {
    tabs: {
      get: mockChromeTabsGet,
      update: mockChromeTabsUpdate,
      onUpdated: mockChromeTabsOnUpdated,
    },
    scripting: {
      executeScript: mockChromeScriptingExecuteScript,
    },
  },
  writable: true,
});

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    uploadHtmlChunk: vi.fn().mockResolvedValue({}),
    uploadFilenameMap: vi.fn().mockResolvedValue({}),
    uploadContent: vi.fn(),
    uploadPageContent: vi.fn().mockResolvedValue({}),
  },
  HttpError: class HttpError extends Error {
    constructor(
      msg: string,
      public statusCode: number,
    ) {
      super(msg);
    }
  },
  ServerUnavailableError: class extends Error {},
  AuthenticationError: class extends Error {},
  AssemblyTimeoutError: class extends Error {},
}));

const mockGetResources = vi.fn();
vi.mock("../../src/background/resources", () => ({
  getResources: (...args: any[]) => mockGetResources(...args),
}));

// The fetch/enqueue boundary. Each handler returns a map entry so the
// filename-map merge/delta path stays exercised whenever a category IS on.
vi.mock("../../src/background/fileHandlers", () => ({
  addCssFiles: vi.fn(async () => new Map([["style.css", "styles/style.css"]])),
  addJsFiles: vi.fn(async () => new Map([["app.js", "scripts/app.js"]])),
  addImageFiles: vi.fn(async () => new Map([["logo.png", "images/logo.png"]])),
  addDocumentFiles: vi.fn(
    async () => new Map([["doc.pdf", "documents/doc.pdf"]]),
  ),
}));

// NOTE: src/background/urlUtils is NOT mocked — asset-registry reads
// urlUtils.buildArchivePath via `import * as urlUtils`, and a partial mock
// makes vitest 4 throw for the missing export. The real module is pure
// string helpers, safe to load.

import {
  addCssFiles,
  addJsFiles,
  addImageFiles,
  addDocumentFiles,
} from "../../src/background/fileHandlers";
import { serverClient } from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A linked page carrying one asset of every category. */
function mockPageWithAssets() {
  mockGetResources.mockReturnValue({
    css: ["style.css"],
    js: ["app.js"],
    images: ["logo.png"],
    documents: ["doc.pdf"],
    links: [],
    text: "Linked page text",
  });
}

function mockScraperTabFlow() {
  mockChromeTabsGet.mockResolvedValue({ url: "https://example.com/start" });
  // Navigation completes immediately with the target URL.
  mockChromeTabsUpdate.mockImplementation((_tabId: any, opts: any) => {
    const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
    const listener = calls[calls.length - 1]?.[0];
    if (listener) {
      setTimeout(
        () => listener(1, { status: "complete" }, { url: opts.url }),
        0,
      );
    }
    return Promise.resolve();
  });
  // Scroll script (args present) and DOM capture (no args).
  mockChromeScriptingExecuteScript.mockImplementation((opts: any) => {
    if (opts.args) return Promise.resolve([{ result: null }]);
    return Promise.resolve([
      {
        result: {
          skeleton: "<html><head></head><body></body></html>",
          bodyChildren: ["<div>x</div>"],
        },
      },
    ]);
  });
}

/** Queue one linked page and run the full scrape against a server session. */
async function scrapeOnePage(scraper: LinkedPageScraper) {
  const storage = { addFile: vi.fn().mockResolvedValue(undefined) };
  await scraper.addToQueue({
    url: "https://example.com/about",
    depth: 1,
    parentUrl: "https://example.com",
    status: "queued",
  });
  await scraper.processQueue(1, storage, vi.fn());
  return storage;
}

function expectNoHandlersCalled() {
  expect(addImageFiles).not.toHaveBeenCalled();
  expect(addCssFiles).not.toHaveBeenCalled();
  expect(addJsFiles).not.toHaveBeenCalled();
  expect(addDocumentFiles).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPageWithAssets();
  mockScraperTabFlow();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("linked-page asset gating (multipage-download-fixes 1.1 / D1)", () => {
  it("text-only run (all category flags off) fetches zero assets", async () => {
    // download-core would pass the normalized text-only snapshot here:
    // normalizeTextOnlyOptions zeroes images/assets/documents while
    // fullScraping (downloadLinksFullScraping) stays enabled.
    const scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
      serverSessionId: "sess-1",
      downloadImages: false,
      downloadAssets: false,
      downloadDocuments: false,
    });

    const storage = await scrapeOnePage(scraper);

    // No handler invocation → no fetch, no UploadQueue enqueue.
    expectNoHandlersCalled();
    // No direct storage writes either.
    expect(storage.addFile).not.toHaveBeenCalled();
    // An empty delta filename map must not be uploaded.
    expect(serverClient.uploadFilenameMap).not.toHaveBeenCalled();
  });

  it("images-only mode fetches images but not css/js/documents", async () => {
    const scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
      serverSessionId: "sess-1",
      downloadImages: true,
      downloadAssets: false,
      downloadDocuments: false,
    });

    await scrapeOnePage(scraper);

    expect(addImageFiles).toHaveBeenCalledTimes(1);
    expect(addCssFiles).not.toHaveBeenCalled();
    expect(addJsFiles).not.toHaveBeenCalled();
    expect(addDocumentFiles).not.toHaveBeenCalled();
    // Delta filename-map upload still carries the image entry.
    expect(serverClient.uploadFilenameMap).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ "logo.png": "images/logo.png" }),
    );
  });

  it("html-on run (all flags true) still fetches every category", async () => {
    const scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
      serverSessionId: "sess-1",
      downloadImages: true,
      downloadAssets: true,
      downloadDocuments: true,
    });

    await scrapeOnePage(scraper);

    expect(addImageFiles).toHaveBeenCalledTimes(1);
    expect(addCssFiles).toHaveBeenCalledTimes(1);
    expect(addJsFiles).toHaveBeenCalledTimes(1);
    expect(addDocumentFiles).toHaveBeenCalledTimes(1);
  });

  it("gating fields absent → assets still flow (backward-compat defaults)", async () => {
    // Existing constructions without the new fields keep current behavior.
    const scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
      serverSessionId: "sess-1",
    });

    await scrapeOnePage(scraper);

    expect(addImageFiles).toHaveBeenCalledTimes(1);
    expect(addCssFiles).toHaveBeenCalledTimes(1);
    expect(addJsFiles).toHaveBeenCalledTimes(1);
    expect(addDocumentFiles).toHaveBeenCalledTimes(1);
  });
});

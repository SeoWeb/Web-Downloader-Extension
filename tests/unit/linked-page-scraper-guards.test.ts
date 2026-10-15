/**
 * Tests for LinkedPageScraper guards (task 4.7):
 * - maxPages is clamped into [1, 500] (the docstring claimed "Max: 200" but
 *   any value was accepted),
 * - restoreOriginalPage does NOT clobber user navigation: the tab is only
 *   navigated back when it is still on scraper-controlled URLs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LinkedPageScraper,
  clampMaxPages,
  MIN_MAX_PAGES,
  MAX_MAX_PAGES,
} from "../../src/background/linked-page-scraper";
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
  },
  HttpError: class HttpError extends Error {
    constructor(msg: string, public statusCode: number) {
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

vi.mock("../../src/background/fileHandlers", () => ({
  addCssFiles: vi.fn().mockResolvedValue(undefined),
  addJsFiles: vi.fn().mockResolvedValue(undefined),
  addImageFiles: vi.fn().mockResolvedValue(new Map()),
  addDocumentFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/background/urlUtils", () => ({
  fixFilename: (name: string) => name,
}));

// ---------------------------------------------------------------------------

const ORIGINAL_URL = "https://example.com/start";

function createScraper(): LinkedPageScraper {
  return new LinkedPageScraper(new AssetRegistry(), {
    maxPages: 5,
    delayBetweenPages: 0,
    pageTimeout: 5000,
  });
}

/** Make navigation complete immediately with the target URL. */
function mockImmediateNavigation() {
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
}

function mockEmptyPage() {
  mockGetResources.mockReturnValue({
    css: [],
    js: [],
    images: [],
    documents: [],
    links: [],
    text: "page text",
  });
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

beforeEach(() => {
  vi.clearAllMocks();
  mockEmptyPage();
  mockImmediateNavigation();
});

// ---------------------------------------------------------------------------
// maxPages clamping
// ---------------------------------------------------------------------------

describe("maxPages clamping (task 4.7)", () => {
  it("exports the documented bounds", () => {
    expect(MIN_MAX_PAGES).toBe(1);
    expect(MAX_MAX_PAGES).toBe(500);
  });

  it("defaults to 50", () => {
    expect(clampMaxPages(undefined)).toBe(50);
    const scraper = new LinkedPageScraper(new AssetRegistry());
    expect(scraper["options"].maxPages).toBe(50);
  });

  it("clamps values above 500 down to 500", () => {
    expect(clampMaxPages(10_000)).toBe(500);
    const scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 10_000,
    });
    expect(scraper["options"].maxPages).toBe(500);
  });

  it("clamps values below 1 up to 1", () => {
    expect(clampMaxPages(0)).toBe(1);
    expect(clampMaxPages(-50)).toBe(1);
    const scraper = new LinkedPageScraper(new AssetRegistry(), { maxPages: 0 });
    expect(scraper["options"].maxPages).toBe(1);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampMaxPages(Number.NaN)).toBe(50);
    expect(clampMaxPages(Number.POSITIVE_INFINITY)).toBe(50);
  });

  it("floors fractional values and keeps valid values", () => {
    expect(clampMaxPages(7.9)).toBe(7);
    expect(clampMaxPages(200)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// restoreOriginalPage guard
// ---------------------------------------------------------------------------

describe("restoreOriginalPage guard (task 4.7)", () => {
  it("restores the original page when the tab is still on the last scraped URL", async () => {
    // Before scrape: tab sits on the original page; at restore time it is
    // still on the last scraped URL (in the scrape set)
    mockChromeTabsGet
      .mockResolvedValueOnce({ url: ORIGINAL_URL })
      .mockResolvedValue({ url: "https://example.com/about" });

    const scraper = createScraper();
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    await scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());

    expect(mockChromeTabsUpdate).toHaveBeenCalledWith(1, {
      url: ORIGINAL_URL,
    });
  });

  it("does NOT clobber the tab when the user navigated elsewhere mid-scrape", async () => {
    // Before scrape: original page
    mockChromeTabsGet.mockResolvedValueOnce({ url: ORIGINAL_URL });

    const scraper = createScraper();
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    // During the scrape the user navigated the tab somewhere unrelated
    mockChromeTabsGet.mockResolvedValue({
      url: "https://unrelated-site.com/dashboard",
    });

    await scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());

    // The scrape navigation itself calls update; the guard must ensure the
    // tab is never forced back to the original URL.
    expect(mockChromeTabsUpdate).not.toHaveBeenCalledWith(1, {
      url: ORIGINAL_URL,
    });
  });

  it("does not navigate back when the tab is already on the original URL", async () => {
    mockChromeTabsGet.mockResolvedValue({ url: ORIGINAL_URL });

    const scraper = createScraper();
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    await scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());

    // restoreOriginalPage early-returns — the only update call is the
    // scrape navigation itself
    const updateUrls = mockChromeTabsUpdate.mock.calls.map(
      (c) => (c[1] as any).url,
    );
    expect(updateUrls).toContain("https://example.com/about");
    expect(updateUrls).not.toContain(ORIGINAL_URL);
  });

  it("does not restore when the original URL is unknown", async () => {
    mockChromeTabsGet.mockResolvedValue({ url: "" });

    const scraper = createScraper();
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    await scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());

    const updateUrls = mockChromeTabsUpdate.mock.calls.map(
      (c) => (c[1] as any).url,
    );
    expect(updateUrls).not.toContain(ORIGINAL_URL);
  });
});

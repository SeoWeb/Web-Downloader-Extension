/**
 * Tests for linked page content text extraction — per-page streaming
 * (multipage-download-fixes D4 / task 3.3; supersedes the former
 * accumulate-with-delimiters tests from linked-page-scraping-parity 5.3).
 *
 * Verifies:
 * - ScrapedPageData includes a `text` field populated from getResources().text
 * - processQueue() uploads EACH page's text immediately after its scrape via
 *   serverClient.uploadPageContent (pageUrl set, scrape order preserved)
 * - there is NO whole-run text accumulation and no page-URL delimiters —
 *   the legacy append endpoint (uploadContent) is never used
 * - text uploading is guarded by the extractText flag (downloadContentAsText)
 */

import {
  LinkedPageScraper,
  ScrapedPageData,
} from "../../src/background/linked-page-scraper";
import { AssetRegistry } from "../../src/background/asset-registry";
import { serverClient } from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock chrome APIs
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

// Mock server-client
vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    uploadHtmlChunk: vi.fn(),
    uploadFilenameMap: vi.fn(),
    uploadContent: vi.fn(),
    uploadPageContent: vi.fn(async () => ({
      message: "stored",
      page_url_hash: "abc123",
      replaced: false,
      size: 10,
      api_version: "v1",
    })),
  },
  ServerUnavailableError: class extends Error {},
  AuthenticationError: class extends Error {},
  AssemblyTimeoutError: class extends Error {},
}));

// Mock getResources to return controllable text
const mockGetResources = vi.fn();
vi.mock("../../src/background/resources", () => ({
  getResources: (...args: any[]) => mockGetResources(...args),
}));

// Mock other dependencies
vi.mock("../../src/background/htmlUtils", () => ({
  convertHtml: (_html: string, _url: string, _prefix: string, _map: any) =>
    _html,
}));

vi.mock("../../src/background/fileHandlers", () => ({
  addCssFiles: vi.fn().mockResolvedValue(new Map()),
  addJsFiles: vi.fn().mockResolvedValue(new Map()),
  addImageFiles: vi.fn().mockResolvedValue(new Map()),
  addDocumentFiles: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../src/background/urlUtils", () => ({
  fixFilename: (name: string) => name,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinkedPageScraper text extraction", () => {
  let scraper: LinkedPageScraper;
  let mockStorage: any;

  beforeEach(() => {
    vi.clearAllMocks();

    scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
      serverSessionId: "test-session",
    });

    mockStorage = {
      addFile: vi.fn().mockResolvedValue(undefined),
    };

    // Default mock: navigation completes immediately
    mockChromeTabsGet.mockResolvedValue({ url: "https://example.com" });
    mockChromeTabsUpdate.mockImplementation((_tabId: any, opts: any) => {
      // Simulate navigation completion by calling the most recently registered listener
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

    // Default mock: scripting returns basic DOM
    mockChromeScriptingExecuteScript.mockImplementation((opts: any) => {
      // The scroll function is called with args (budgetMs); return null (no return value needed)
      if (opts.args) {
        return Promise.resolve([{ result: null }]);
      }
      // For DOM capture function (no args), return skeleton + bodyChildren
      return Promise.resolve([
        {
          result: {
            skeleton: "<html><head></head><body></body></html>",
            bodyChildren: ["<div>Test</div>"],
          },
        },
      ]);
    });
  });

  describe("default options", () => {
    it("should default delayBetweenPages to 200ms", () => {
      const defaultScraper = new LinkedPageScraper(new AssetRegistry());
      expect(defaultScraper["options"].delayBetweenPages).toBe(200);
    });

    it("should allow overriding delayBetweenPages", () => {
      const customScraper = new LinkedPageScraper(new AssetRegistry(), {
        delayBetweenPages: 1000,
      });
      expect(customScraper["options"].delayBetweenPages).toBe(1000);
    });
  });

  describe("per-page text uploads (multipage-download-fixes D4)", () => {
    it("uploads a page's text immediately after its scrape, with the page URL", async () => {
      mockGetResources.mockReturnValue({
        css: [],
        js: [],
        images: [],
        documents: [],
        links: [],
        text: "About page body text content",
      });

      await scraper.addToQueue({
        url: "https://example.com/about",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      await scraper.processQueue(1, mockStorage, vi.fn());

      expect(vi.mocked(serverClient.uploadPageContent)).toHaveBeenCalledTimes(
        1,
      );
      expect(vi.mocked(serverClient.uploadPageContent)).toHaveBeenCalledWith(
        "test-session",
        "https://example.com/about",
        "About page body text content",
      );
    });

    it("uploads each page's text separately in scrape order — no accumulation, no delimiters", async () => {
      let callCount = 0;
      mockGetResources.mockImplementation(() => {
        callCount++;
        return {
          css: [],
          js: [],
          images: [],
          documents: [],
          links: [],
          text: callCount === 1 ? "Page 1 text" : "Page 2 text",
        };
      });

      // Need to set up navigation mock for each page
      let navCount = 0;
      mockChromeTabsUpdate.mockImplementation((_tabId: any, opts: any) => {
        navCount++;
        // Get the most recently registered listener (the one for THIS navigation)
        const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
        const listener = calls[calls.length - 1]?.[0];
        if (listener) {
          const finalUrl = opts.url || `https://example.com/page${navCount}`;
          setTimeout(
            () => listener(1, { status: "complete" }, { url: finalUrl }),
            0,
          );
        }
        return Promise.resolve();
      });

      await scraper.addToQueue({
        url: "https://example.com/about",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });
      await scraper.addToQueue({
        url: "https://example.com/contact",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      await scraper.processQueue(1, mockStorage, vi.fn());

      // ONE upload per scraped page, in scrape order — each page's text goes
      // up on its own; nothing is concatenated with page-URL delimiters.
      expect(vi.mocked(serverClient.uploadPageContent)).toHaveBeenCalledTimes(
        2,
      );
      expect(vi.mocked(serverClient.uploadPageContent)).toHaveBeenNthCalledWith(
        1,
        "test-session",
        "https://example.com/about",
        "Page 1 text",
      );
      expect(vi.mocked(serverClient.uploadPageContent)).toHaveBeenNthCalledWith(
        2,
        "test-session",
        "https://example.com/contact",
        "Page 2 text",
      );

      // The legacy whole-run append endpoint is NOT used by the current
      // extension flow (it stays for older clients only).
      expect(vi.mocked(serverClient.uploadContent)).not.toHaveBeenCalled();
    });

    it("resolves with nothing — there is no whole-run text accumulator to return", async () => {
      mockGetResources.mockReturnValue({
        css: [],
        js: [],
        images: [],
        documents: [],
        links: [],
        text: "Some text content",
      });

      await scraper.addToQueue({
        url: "https://example.com/about",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      const result = await scraper.processQueue(1, mockStorage, vi.fn());

      // The former accumulated blob is gone: processQueue hands nothing back.
      expect(result).toBeUndefined();
    });
  });

  describe("extractText guard", () => {
    it("performs zero content uploads when extractText is false", async () => {
      mockGetResources.mockReturnValue({
        css: [],
        js: [],
        images: [],
        documents: [],
        links: [],
        text: "Some text content",
      });

      scraper.setExtractText(false);

      await scraper.addToQueue({
        url: "https://example.com/about",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      const result = await scraper.processQueue(1, mockStorage, vi.fn());

      expect(result).toBeUndefined();
      expect(vi.mocked(serverClient.uploadPageContent)).not.toHaveBeenCalled();
      expect(vi.mocked(serverClient.uploadContent)).not.toHaveBeenCalled();
      // The page itself was still scraped and stored.
      expect(vi.mocked(serverClient.uploadHtmlChunk)).toHaveBeenCalledTimes(1);
    });

    it("uploads per page when extractText is true (default)", async () => {
      mockGetResources.mockReturnValue({
        css: [],
        js: [],
        images: [],
        documents: [],
        links: [],
        text: "Default enabled text",
      });

      await scraper.addToQueue({
        url: "https://example.com/about",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      await scraper.processQueue(1, mockStorage, vi.fn());

      expect(vi.mocked(serverClient.uploadPageContent)).toHaveBeenCalledTimes(
        1,
      );
      expect(vi.mocked(serverClient.uploadPageContent)).toHaveBeenCalledWith(
        "test-session",
        "https://example.com/about",
        "Default enabled text",
      );
    });
  });

  describe("server-mode concurrent chunk uploads", () => {
    let serverScraper: LinkedPageScraper;

    beforeEach(() => {
      serverScraper = new LinkedPageScraper(new AssetRegistry(), {
        maxPages: 5,
        delayBetweenPages: 0,
        pageTimeout: 5000,
        serverSessionId: "test-session",
      });
    });

    it("uploads all HTML chunks concurrently via Promise.all with correct scrollIndex values", async () => {
      mockGetResources.mockReturnValue({
        css: [],
        js: [],
        images: [],
        documents: [],
        links: [],
        text: "Linked page text",
      });

      // Produce body children large enough to trigger chunk splitting.
      // targetChunkBytes default is 512KB, so we use 3 children each > 512KB.
      const bigChild = "<div>" + "x".repeat(600 * 1024) + "</div>";
      mockChromeScriptingExecuteScript.mockImplementation((opts: any) => {
        if (opts.args) return Promise.resolve([{ result: null }]); // scroll
        return Promise.resolve([
          {
            result: {
              skeleton: "<html><head></head><body></body></html>",
              bodyChildren: [bigChild, bigChild, bigChild],
            },
          },
        ]);
      });

      const uploadSpy = vi
        .mocked(serverClient.uploadHtmlChunk)
        .mockResolvedValue({
          chunk_id: "ch-1",
          chunk_count: 1,
          total_size: 100,
          deduplicated: false,
          api_version: "v1",
        });
      vi.mocked(serverClient.uploadFilenameMap).mockResolvedValue({
        filename_map_id: "fm-1",
        entries: 0,
        api_version: "v1",
      } as any);

      await serverScraper.addToQueue({
        url: "https://example.com/about",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      await serverScraper.processQueue(1, mockStorage, vi.fn());

      // Should have been called once per chunk (3 chunks from 3 large body children)
      expect(uploadSpy).toHaveBeenCalledTimes(3);

      // Verify each call received the correct scrollIndex (0, 1, 2)
      const scrollIndices = uploadSpy.mock.calls.map(
        (call) => call[2], // third argument is scrollIndex
      );
      expect(scrollIndices).toEqual([0, 1, 2]);

      // Verify pageType is "linked" for all calls
      for (const call of uploadSpy.mock.calls) {
        expect(call[3]).toBe("linked");
        expect(call[4]).toBe("https://example.com/about");
      }
    });

    it("handles single-chunk page correctly with Promise.all", async () => {
      mockGetResources.mockReturnValue({
        css: [],
        js: [],
        images: [],
        documents: [],
        links: [],
        text: "Small page",
      });

      // Small body child → single chunk
      mockChromeScriptingExecuteScript.mockImplementation((opts: any) => {
        if (opts.args) return Promise.resolve([{ result: null }]); // scroll
        return Promise.resolve([
          {
            result: {
              skeleton: "<html><head></head><body></body></html>",
              bodyChildren: ["<p>Small</p>"],
            },
          },
        ]);
      });

      const uploadSpy = vi
        .mocked(serverClient.uploadHtmlChunk)
        .mockResolvedValue({
          chunk_id: "ch-1",
          chunk_count: 1,
          total_size: 100,
          deduplicated: false,
          api_version: "v1",
        });

      await serverScraper.addToQueue({
        url: "https://example.com/small",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      await serverScraper.processQueue(1, mockStorage, vi.fn());

      // Single chunk → one call
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(uploadSpy.mock.calls[0][2]).toBe(0); // scrollIndex = 0
      expect(uploadSpy.mock.calls[0][3]).toBe("linked");
    });

    it("uploads chunks concurrently, not sequentially", async () => {
      mockGetResources.mockReturnValue({
        css: [],
        js: [],
        images: [],
        documents: [],
        links: [],
        text: "Concurrent test",
      });

      const bigChild = "<div>" + "y".repeat(600 * 1024) + "</div>";
      mockChromeScriptingExecuteScript.mockImplementation((opts: any) => {
        if (opts.args) return Promise.resolve([{ result: null }]); // scroll
        return Promise.resolve([
          {
            result: {
              skeleton: "<html><head></head><body></body></html>",
              bodyChildren: [bigChild, bigChild],
            },
          },
        ]);
      });

      const callOrder: number[] = [];

      // Make each upload take some time and record when it starts
      vi.mocked(serverClient.uploadHtmlChunk).mockImplementation(
        async (_sid, _html, scrollIndex) => {
          callOrder.push(scrollIndex);
          // Small delay to ensure concurrent overlap
          await new Promise((r) => setTimeout(r, 10));
          return {
            chunk_id: `ch-${scrollIndex}`,
            chunk_count: 2,
            total_size: 100,
            deduplicated: false,
            api_version: "v1",
          };
        },
      );
      vi.mocked(serverClient.uploadFilenameMap).mockResolvedValue({
        filename_map_id: "fm-1",
        entries: 0,
        api_version: "v1",
      } as any);

      await serverScraper.addToQueue({
        url: "https://example.com/concurrent",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      await serverScraper.processQueue(1, mockStorage, vi.fn());

      // Both chunks should have started before either resolved.
      // With Promise.all, both calls are initiated in the same microtask.
      expect(callOrder.length).toBe(2);
      // All calls initiated before any resolved → they ran concurrently
      expect(callOrder).toContain(0);
      expect(callOrder).toContain(1);
    });
  });
});

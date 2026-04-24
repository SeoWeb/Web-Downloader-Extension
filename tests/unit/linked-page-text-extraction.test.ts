/**
 * Tests for linked page content text extraction (linked-page-scraping-parity task 5.3).
 *
 * Verifies:
 * - ScrapedPageData includes a `text` field populated from getResources().text
 * - processQueue() accumulates text with page-URL delimiters
 * - Text accumulation is guarded by extractText flag (downloadContentAsText)
 */

import { LinkedPageScraper, ScrapedPageData } from "../../src/background/linked-page-scraper";
import { AssetRegistry } from "../../src/background/asset-registry";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock chrome APIs
const mockChromeTabsGet = jest.fn();
const mockChromeTabsUpdate = jest.fn();
const mockChromeTabsOnUpdated = {
  addListener: jest.fn(),
  removeListener: jest.fn(),
};
const mockChromeScriptingExecuteScript = jest.fn();

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
jest.mock("../../src/background/server-client", () => ({
  serverClient: {
    uploadHtmlChunk: jest.fn(),
    uploadFilenameMap: jest.fn(),
    uploadContent: jest.fn(),
  },
  ServerUnavailableError: class extends Error {},
  AuthenticationError: class extends Error {},
  AssemblyTimeoutError: class extends Error {},
}));

// Mock getResources to return controllable text
const mockGetResources = jest.fn();
jest.mock("../../src/background/resources", () => ({
  getResources: (...args: any[]) => mockGetResources(...args),
}));

// Mock other dependencies
jest.mock("../../src/background/htmlUtils", () => ({
  convertHtml: (_html: string, _url: string, _prefix: string, _map: any) => _html,
}));

jest.mock("../../src/background/fileHandlers", () => ({
  addCssFiles: jest.fn().mockResolvedValue(new Map()),
  addJsFiles: jest.fn().mockResolvedValue(new Map()),
  addImageFiles: jest.fn().mockResolvedValue(new Map()),
  addDocumentFiles: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock("../../src/background/urlUtils", () => ({
  fixFilename: (name: string) => name,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinkedPageScraper text extraction", () => {
  let scraper: LinkedPageScraper;
  let mockStorage: any;

  beforeEach(() => {
    jest.clearAllMocks();

    scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
    });

    mockStorage = {
      addFile: jest.fn().mockResolvedValue(undefined),
    };

    // Default mock: navigation completes immediately
    mockChromeTabsGet.mockResolvedValue({ url: "https://example.com" });
    mockChromeTabsUpdate.mockImplementation((_tabId: any, opts: any) => {
      // Simulate navigation completion by calling the most recently registered listener
      const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
      const listener = calls[calls.length - 1]?.[0];
      if (listener) {
        setTimeout(() => listener(1, { status: "complete" }, { url: opts.url }), 0);
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
      return Promise.resolve([{
        result: {
          skeleton: "<html><head></head><body></body></html>",
          bodyChildren: ["<div>Test</div>"],
        },
      }]);
    });
  });

  describe("ScrapedPageData text field", () => {
    it("should include text field from getResources()", async () => {
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

      const result = await scraper.processQueue(1, mockStorage, jest.fn());

      expect(result).toContain("About page body text content");
    });

    it("should accumulate text from multiple pages with delimiters", async () => {
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
          setTimeout(() => listener(1, { status: "complete" }, { url: finalUrl }), 0);
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

      const result = await scraper.processQueue(1, mockStorage, jest.fn());

      // Should contain both pages' text with delimiters
      expect(result).toContain("Page 1 text");
      expect(result).toContain("Page 2 text");
      expect(result).toContain("--- https://example.com/");
      expect(result).toContain("---");
    });
  });

  describe("extractText guard", () => {
    it("should return empty string when extractText is false", async () => {
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

      const result = await scraper.processQueue(1, mockStorage, jest.fn());

      expect(result).toBe("");
    });

    it("should return accumulated text when extractText is true (default)", async () => {
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

      const result = await scraper.processQueue(1, mockStorage, jest.fn());

      expect(result).toContain("Default enabled text");
    });
  });

  describe("text delimiter format", () => {
    it("should use \\n--- URL ---\\n format", async () => {
      mockGetResources.mockReturnValue({
        css: [],
        js: [],
        images: [],
        documents: [],
        links: [],
        text: "Body content",
      });

      await scraper.addToQueue({
        url: "https://example.com/about",
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });

      const result = await scraper.processQueue(1, mockStorage, jest.fn());

      // Verify the delimiter format
      expect(result).toMatch(/\n--- .*? ---\n/);
      expect(result).toContain("Body content");
    });
  });
});

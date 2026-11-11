/**
 * Per-page text streaming tests (multipage-download-fixes D4 / tasks 3.1–3.3).
 *
 * Verifies the honest per-page flow:
 * - the MAIN page's text is uploaded FIRST, before any linked page's text
 *   (the ordering defect bite — at HEAD the main text is appended last),
 * - each scraped linked page's text is uploaded immediately after its scrape
 *   via uploadPageContent (pageUrl set; null only for the main page),
 * - there is no whole-run text accumulator: the legacy append endpoint is
 *   never called and processQueue hands nothing back to append,
 * - a per-page text upload failure is surfaced in the failure counts without
 *   failing the run (scraping continues, finalize still includes what came),
 * - the park-resume path uploads per page (the §4 end-of-run tail append is
 *   gone) and honors the frozen extractText gate from the snapshot,
 * - extractText off → zero content uploads.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Hoisted state shared with the module mocks (factories run at import time).
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
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
    /** Session id the mock createSession hands out. */
    sessionId: "session-stream-1",
    /** LinkedPageScraper instances constructed by download-core. */
    scrapers: [] as Array<any>,
    /** Links returned by the mocked getResources() (download-core harness). */
    links: [] as string[],
    /** Main page text returned by the mocked getResources(). */
    mainText: "main page text",
    /** Sequential per-page text responses for the REAL-scraper tests. */
    pageTexts: [] as string[],
    /** Overridable getResources implementation for the real-scraper tests. */
    getResourcesImpl: null as null | (() => any),
    /** Every uploadPageContent call: [sessionId, pageUrl, text]. */
    pageContentCalls: [] as Array<[string, string | null, string]>,
    /** Every uploadContent call: [sessionId, text]. */
    uploadContentCalls: [] as Array<[string, string]>,
    /** Ordered event markers ("pageText:<url>" / "scrapeComplete"). */
    eventOrder: [] as string[],
    /** When true, the null-page (main) uploadPageContent call rejects. */
    failMainTextUpload: false,
    /** Texts whose per-page upload rejects (failure-isolation tests). */
    failPageTexts: new Set<string>(),
    /** When set, the mocked scraper's processQueue resolves with this value
     *  (simulates the OLD accumulator contract for the park-tail bite). */
    scraperQueueReturn: undefined as unknown,
    fakeQueue,
  };
});

// ---------------------------------------------------------------------------
// chrome — tabs + scripting (real-scraper tests), runtime (keepalive),
// session storage (scraper-snapshot round-trips).
// ---------------------------------------------------------------------------

const mockChromeTabsGet = vi.fn();
const mockChromeTabsUpdate = vi.fn();
const mockChromeTabsOnUpdated = {
  addListener: vi.fn(),
  removeListener: vi.fn(),
};
const mockChromeScriptingExecuteScript = vi.fn();

type SessionStore = Map<string, unknown>;
const sessionStore: SessionStore = new Map();

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
    runtime: {
      connect: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      }),
    },
    storage: {
      session: {
        get: async (keys?: string | string[] | null) => {
          if (keys === null || keys === undefined) {
            return Object.fromEntries(sessionStore);
          }
          const wanted = typeof keys === "string" ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const k of wanted) {
            if (sessionStore.has(k)) out[k] = sessionStore.get(k);
          }
          return out;
        },
        set: async (objs: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(objs)) sessionStore.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          for (const k of typeof keys === "string" ? [keys] : keys) {
            sessionStore.delete(k);
          }
        },
      },
    },
  },
  writable: true,
});

// ---------------------------------------------------------------------------
// Module mocks (download-core harness — mirrors
// download-core-linked-pages-gate.test.ts, driven to SUCCESS)
// ---------------------------------------------------------------------------

vi.mock("../../src/background/cleanupHandlers", () => ({
  cleanupAfterDownload: vi.fn(async () => {}),
}));
vi.mock("../../src/background/download-checkpoint", () => ({
  writeCheckpoint: vi.fn(async () => {}),
  updateCheckpointPhase: vi.fn(),
  updateCheckpointResourceUrls: vi.fn(async () => {}),
  clearCheckpoint: vi.fn(async () => {}),
  readCheckpoint: vi.fn(async () => null),
  pauseCheckpoint: vi.fn(async () => {}),
  restoreCheckpointPhase: vi.fn(async () => {}),
}));
vi.mock("../../src/background/download-utils", () => ({
  performInitialCleanup: vi.fn(async () => {}),
}));
vi.mock("../../src/background/resources", () => ({
  getResources: (...args: any[]) =>
    h.getResourcesImpl
      ? h.getResourcesImpl(...args)
      : {
          images: [],
          css: [],
          js: [],
          links: h.links,
          documents: [],
          text: h.mainText,
        },
}));
vi.mock("../../src/background/download-processors", () => ({
  processImages: vi.fn(async () => new Map()),
  processAssets: vi.fn(async () => new Map()),
  processDocuments: vi.fn(async () => new Map()),
  mergeFilenameMaps: vi.fn(() => new Map()),
}));

/**
 * Mocked LinkedPageScraper simulating the NEW per-page contract: each
 * scraped linked page's text is uploaded by the scraper itself, right
 * after the scrape — processQueue hands NOTHING back to append.
 */
vi.mock("../../src/background/linked-page-scraper", () => ({
  LinkedPageScraper: class {
    ctorArgs: unknown[];
    queued: Array<Record<string, unknown>> = [];
    extractText: unknown = true;
    snapshot: unknown;
    constructor(...args: unknown[]) {
      h.scrapers.push(this);
      this.ctorArgs = args;
    }
    setExtractText(value: unknown) {
      this.extractText = value;
    }
    async addToQueue(task: Record<string, unknown>) {
      this.queued.push(task);
    }
    async reacquireTab(tabId: number) {
      return tabId;
    }
    static fromSnapshot(snapshot: any, _assetRegistry: unknown) {
      const inst = new (this as any)(
        { register: () => {} },
        { serverSessionId: snapshot.serverSessionId },
      );
      inst.snapshot = snapshot;
      // The real fromSnapshot applies the frozen extractText gate (D4:
      // park-resume uploads per page with the same gate).
      inst.extractText = snapshot.options.extractText;
      return inst;
    }
    async processQueue() {
      // Per-page streaming: the remaining linked page's text goes up now.
      if (this.extractText) {
        const { serverClient } =
          await import("../../src/background/server-client");
        await serverClient.uploadPageContent(
          h.sessionId,
          "https://fixture.test/sub.html",
          "sub page text",
        );
      }
      return h.scraperQueueReturn;
    }
  },
}));
vi.mock("../../src/background/storage/server-storage-adapter", () => ({
  ServerStorageAdapter: class {
    setSessionId() {}
    getUploadQueue() {
      return h.fakeQueue;
    }
  },
}));

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    baseUrl: "https://server.example.com",
    createSession: vi.fn(async () => h.sessionId),
    uploadHtmlChunk: vi.fn(async () => ({ api_version: "v1" })),
    uploadFilenameMap: vi.fn(async () => ({ api_version: "v1" })),
    uploadPageContent: vi.fn(
      async (sessionId: string, pageUrl: string | null, text: string) => {
        h.eventOrder.push("uploadPageContent");
        if (h.failMainTextUpload && pageUrl === null) {
          throw new Error("main text upload failed");
        }
        if (h.failPageTexts.has(text)) {
          throw new Error(`text upload failed for: ${text}`);
        }
        h.pageContentCalls.push([sessionId, pageUrl, text]);
        return {
          message: "stored",
          page_url_hash: pageUrl === null ? "main" : "abc123",
          replaced: false,
          size: text.length,
          api_version: "v1",
        };
      },
    ),
    uploadContent: vi.fn(async (sessionId: string, text: string) => {
      h.uploadContentCalls.push([sessionId, text]);
      return { message: "appended", size: text.length, api_version: "v1" };
    }),
    scrapeComplete: vi.fn(async () => {
      h.eventOrder.push("scrapeComplete");
      return { id: h.sessionId, status: "uploading", api_version: "v1" };
    }),
    finalizeSession: vi.fn(async () => ({
      id: h.sessionId,
      api_version: "v1",
    })),
    getSessionStatus: vi.fn(async () => ({ status: "scraping" })),
  },
  assertSecureBaseUrl: vi.fn(),
  upgradeInsecureServerUrl: vi.fn((url: string) => url),
  ServerUnavailableError: class extends Error {},
  AuthenticationError: class extends Error {},
  AssemblyTimeoutError: class extends Error {},
  HttpError: class HttpError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));
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

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  downloadResources,
  resumeFromParkedScrape,
} from "../../src/background/download-core";
import { serverClient } from "../../src/background/server-client";
import type {
  LinkedPageScraper,
  LinkedPageScraperOptions,
} from "../../src/background/linked-page-scraper";
import { AssetRegistry } from "../../src/background/asset-registry";
import type { FilterOptions } from "../../src/types/filterTypes";
import type { LinkedScraperSnapshot } from "../../src/background/scraper-snapshot";

/**
 * The linked-page-scraper module is MOCKED for the download-core harness;
 * the Part B/C/D tests need the REAL class (its server-client binding still
 * resolves to the mocked module, so the same spies record its uploads).
 */
let RealLinkedPageScraper: typeof import("../../src/background/linked-page-scraper").LinkedPageScraper;
beforeAll(async () => {
  ({ LinkedPageScraper: RealLinkedPageScraper } = await vi.importActual<
    typeof import("../../src/background/linked-page-scraper")
  >("../../src/background/linked-page-scraper"));
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

function pushedKeys(sendMessage: vi.Mock): string[] {
  return sendMessage.mock.calls.map(
    (call) => (call[0] as { key?: string }).key ?? String(call[0]),
  );
}

function resetHarness() {
  h.scrapers.length = 0;
  h.links = [];
  h.mainText = "main page text";
  h.pageTexts = [];
  h.getResourcesImpl = null;
  h.pageContentCalls.length = 0;
  h.uploadContentCalls.length = 0;
  h.eventOrder.length = 0;
  h.failMainTextUpload = false;
  h.failPageTexts.clear();
  h.scraperQueueReturn = undefined;
  sessionStore.clear();
}

// Real-scraper environment: immediate navigation + simple DOM + controllable
// sequential getResources responses.
function mockRealScraperEnv() {
  h.getResourcesImpl = () => {
    const text = h.pageTexts.shift() ?? "";
    return {
      css: [],
      js: [],
      images: [],
      documents: [],
      links: [],
      text,
    };
  };
  mockChromeTabsGet.mockImplementation(async (tabId: number) => ({
    id: tabId,
    url: "https://example.com",
  }));
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
  mockChromeScriptingExecuteScript.mockImplementation((opts: any) => {
    if (opts.args) return Promise.resolve([{ result: null }]); // scroll
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

function makeServerScraper(
  overrides: Partial<LinkedPageScraperOptions> = {},
): LinkedPageScraper {
  return new RealLinkedPageScraper(new AssetRegistry(), {
    maxPages: 5,
    delayBetweenPages: 0,
    pageTimeout: 5000,
    serverSessionId: h.sessionId,
    downloadImages: false,
    downloadAssets: false,
    downloadDocuments: false,
    ...overrides,
  });
}

function makeSnapshot(
  overrides: Partial<LinkedScraperSnapshot> = {},
): LinkedScraperSnapshot {
  return {
    version: 1,
    serverSessionId: h.sessionId,
    tabId: TAB_ID,
    tabUrl: "https://fixture.test/page.html",
    phase: "internal",
    internalQueue: [
      {
        url: "https://fixture.test/sub.html",
        depth: 1,
        parentUrl: "https://fixture.test/page.html",
      },
    ],
    externalQueue: [],
    visitedUrls: [],
    successCount: 0,
    failCount: 0,
    options: {
      maxPages: 10,
      delayBetweenPages: 0,
      includeExternal: false,
      pageTimeout: 30000,
      downloadImages: false,
      downloadAssets: false,
      downloadDocuments: false,
      extractText: true,
    },
    previousCheckpointPhase: "scraping",
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHarness();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Part A — download-core level: main-first ordering + no end-of-run append
// ---------------------------------------------------------------------------

describe("per-page text streaming — main-first ordering (task 3.3 bite)", () => {
  it("uploads the MAIN page's text BEFORE any linked page's text, and never touches the legacy append endpoint", async () => {
    h.links = ["https://fixture.test/sub.html"];

    const sendMessage = await runDownload(
      downloadOptions({
        downloadContentAsText: true,
        downloadLinksFullScraping: true,
      }),
    );

    // Main first (pageUrl null), linked page second — in that order.
    expect(h.pageContentCalls).toEqual([
      [h.sessionId, null, "main page text"],
      [h.sessionId, "https://fixture.test/sub.html", "sub page text"],
    ]);

    // The legacy whole-run append endpoint is NOT used by the current flow —
    // there is no end-of-run single append of an accumulated blob.
    expect(h.uploadContentCalls).toEqual([]);
    expect(vi.mocked(serverClient.uploadContent)).not.toHaveBeenCalled();

    // The run completes normally.
    expect(pushedKeys(sendMessage)).toContain("status.complete");
  });

  it("a main-page text upload failure is surfaced but does not abort the run", async () => {
    h.links = ["https://fixture.test/sub.html"];
    h.failMainTextUpload = true;

    const sendMessage = await runDownload(
      downloadOptions({
        downloadContentAsText: true,
        downloadLinksFullScraping: true,
      }),
    );

    // The main text upload was attempted (and failed)…
    expect(h.eventOrder).toContain("uploadPageContent");
    // …but the linked page's text still went up and the run completed.
    expect(h.pageContentCalls).toEqual([
      [h.sessionId, "https://fixture.test/sub.html", "sub page text"],
    ]);
    expect(pushedKeys(sendMessage)).toContain("status.complete");
  });

  it("extractText off (downloadContentAsText false) → zero content uploads", async () => {
    h.links = ["https://fixture.test/sub.html"];

    const sendMessage = await runDownload(downloadOptions());

    expect(h.pageContentCalls).toEqual([]);
    expect(h.uploadContentCalls).toEqual([]);
    expect(pushedKeys(sendMessage)).toContain("status.complete");
  });
});

// ---------------------------------------------------------------------------
// Part B — REAL LinkedPageScraper: per-page uploads, failure isolation, gate
// ---------------------------------------------------------------------------

describe("LinkedPageScraper per-page text uploads (task 3.2)", () => {
  it("uploads each scraped page's text immediately after its scrape, in scrape order, with the page URL", async () => {
    mockRealScraperEnv();
    h.pageTexts = ["Page 1 text", "Page 2 text"];
    const scraper = makeServerScraper();
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

    // processQueue hands NOTHING back — there is no accumulator to append.
    const result = await scraper.processQueue(
      1,
      { addFile: vi.fn() } as any,
      vi.fn(),
    );
    expect(result).toBeUndefined();

    expect(h.pageContentCalls).toEqual([
      [h.sessionId, "https://example.com/about", "Page 1 text"],
      [h.sessionId, "https://example.com/contact", "Page 2 text"],
    ]);
    // Each page's HTML chunks were uploaded before its text (per-page flow).
    expect(
      vi.mocked(serverClient.uploadHtmlChunk).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    // The legacy append endpoint is never used.
    expect(vi.mocked(serverClient.uploadContent)).not.toHaveBeenCalled();
  });

  it("a per-page text upload failure is counted and surfaced without failing the run", async () => {
    mockRealScraperEnv();
    h.pageTexts = ["Page 1 text", "Page 2 text"];
    h.failPageTexts.add("Page 1 text");

    const sendMessage = vi.fn();
    const scraper = makeServerScraper();
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

    await scraper.processQueue(1, { addFile: vi.fn() } as any, sendMessage);

    // The failed upload is counted; the scrape itself succeeded on both pages.
    const completion = sendMessage.mock.calls
      .map((c) => c[0])
      .find((m: any) => m?.key === "status.linkedPagesComplete");
    expect(completion).toEqual({
      key: "status.linkedPagesComplete",
      options: { succeeded: 2, failed: 1 },
    });
    // Scraping continued: page 2's text was still uploaded.
    expect(h.pageContentCalls).toEqual([
      [h.sessionId, "https://example.com/contact", "Page 2 text"],
    ]);
    // Both pages' HTML chunks made it up — the run's finalization includes them.
    expect(
      vi.mocked(serverClient.uploadHtmlChunk).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("extractText off → zero content uploads even though pages are scraped", async () => {
    mockRealScraperEnv();
    h.pageTexts = ["Some text"];
    const scraper = makeServerScraper();
    scraper.setExtractText(false);
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: "https://example.com",
      status: "queued",
    });

    const result = await scraper.processQueue(
      1,
      { addFile: vi.fn() } as any,
      vi.fn(),
    );

    expect(result).toBeUndefined();
    expect(h.pageContentCalls).toEqual([]);
    expect(vi.mocked(serverClient.uploadPageContent)).not.toHaveBeenCalled();
    expect(vi.mocked(serverClient.uploadContent)).not.toHaveBeenCalled();
    // The page was still scraped and stored.
    expect(vi.mocked(serverClient.uploadHtmlChunk).mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Part C — park-resume: per-page uploads with the frozen extractText gate
// ---------------------------------------------------------------------------

describe("park-resume per-page text (task 3.2 — §4 tail append removed)", () => {
  it("resumeFromParkedScrape uploads pages per page (extractText gate from the snapshot) and performs NO end-of-run tail append", async () => {
    vi.mocked(serverClient.getSessionStatus as any).mockResolvedValue({
      status: "scraping",
      resources_received: 0,
    });
    // Simulate the OLD scraper contract returning an accumulated blob so a
    // surviving tail append would visibly bite.
    h.scraperQueueReturn = "old-style accumulated tail text";

    await resumeFromParkedScrape(makeSnapshot(), vi.fn());

    // The remaining page's text was uploaded per page by the resumed scraper…
    expect(h.pageContentCalls).toEqual([
      [h.sessionId, "https://fixture.test/sub.html", "sub page text"],
    ]);
    // …BEFORE the run's tail (scrapeComplete), never after as an append.
    expect(h.eventOrder).toEqual(["uploadPageContent", "scrapeComplete"]);
    // No end-of-run tail append — the §4 append is gone.
    expect(vi.mocked(serverClient.uploadContent)).not.toHaveBeenCalled();
  });

  it("the resumed scraper honors the frozen extractText=false gate (zero uploads)", async () => {
    vi.mocked(serverClient.getSessionStatus as any).mockResolvedValue({
      status: "scraping",
      resources_received: 0,
    });

    await resumeFromParkedScrape(
      makeSnapshot({
        options: {
          maxPages: 10,
          delayBetweenPages: 0,
          includeExternal: false,
          pageTimeout: 30000,
          downloadImages: false,
          downloadAssets: false,
          downloadDocuments: false,
          extractText: false,
        },
      }),
      vi.fn(),
    );

    expect(h.pageContentCalls).toEqual([]);
    expect(vi.mocked(serverClient.uploadPageContent)).not.toHaveBeenCalled();
    expect(vi.mocked(serverClient.uploadContent)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part D — REAL scraper resume-from-park seed: snapshot gate applied
// ---------------------------------------------------------------------------

describe("LinkedPageScraper.fromSnapshot applies the extractText gate (task 3.2)", () => {
  it("a scraper seeded from the snapshot uploads per page when extractText is true", async () => {
    mockRealScraperEnv();
    h.pageTexts = ["Resumed page text"];
    const scraper = RealLinkedPageScraper.fromSnapshot(
      makeSnapshot(),
      new AssetRegistry(),
    );
    expect(scraper["extractText"]).toBe(true);

    await scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());

    expect(h.pageContentCalls).toEqual([
      [h.sessionId, "https://fixture.test/sub.html", "Resumed page text"],
    ]);
    expect(vi.mocked(serverClient.uploadContent)).not.toHaveBeenCalled();
  });

  it("a scraper seeded from an extractText=false snapshot performs zero content uploads", async () => {
    mockRealScraperEnv();
    h.pageTexts = ["Resumed page text"];
    const snapshot = makeSnapshot();
    snapshot.options.extractText = false;
    const scraper = RealLinkedPageScraper.fromSnapshot(
      snapshot,
      new AssetRegistry(),
    );
    expect(scraper["extractText"]).toBe(false);

    await scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());

    expect(h.pageContentCalls).toEqual([]);
    expect(vi.mocked(serverClient.uploadPageContent)).not.toHaveBeenCalled();
    // The page was still scraped and stored.
    expect(vi.mocked(serverClient.uploadHtmlChunk).mock.calls.length).toBe(1);
  });
});

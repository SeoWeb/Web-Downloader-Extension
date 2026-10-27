/**
 * Tests for LinkedPageScraper guards (task 4.7):
 * - maxPages is clamped into [1, 500] (the docstring claimed "Max: 200" but
 *   any value was accepted),
 * - restoreOriginalPage does NOT clobber user navigation: the tab is only
 *   navigated back when it is still on scraper-controlled URLs.
 *
 * Plus (download-hang-elimination, tasks 2.1/2.4/2.5, 4.1/4.2, 5.1/5.2):
 * - paused-scraper liveness: keepalive-port disconnect resolves the pause
 *   wait with stop semantics; a bounded watchdog stops a stuck pause,
 * - navigation completion matching: the wait resolves only on a completion
 *   belonging to the requested navigation,
 * - DOM capture timer hygiene: race timers are cleared on settlement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LinkedPageScraper,
  clampMaxPages,
  MIN_MAX_PAGES,
  MAX_MAX_PAGES,
  PAUSED_WATCHDOG_MS,
  normalizeNavigationUrl,
} from "../../src/background/linked-page-scraper";
import { AssetRegistry } from "../../src/background/asset-registry";
import {
  createKeepalivePort,
  getKeepalivePort,
} from "../../src/background/download-state";
import { setCurrentScraper } from "../../src/background/scraper-state";

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
const mockChromeRuntimeConnect = vi.fn();

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
      connect: mockChromeRuntimeConnect,
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

afterEach(() => {
  vi.useRealTimers();
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

// ---------------------------------------------------------------------------
// Paused-scraper liveness — keepalive-port disconnect (tasks 2.1, 2.4)
// ---------------------------------------------------------------------------

/** Build a fake chrome.runtime.Port as createKeepalivePort would receive. */
function makeFakePort() {
  return {
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };
}

/** The most recently registered tabs.onUpdated listener. */
function lastOnUpdatedListener() {
  const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
  return calls[calls.length - 1][0] as (
    tabId: number,
    changeInfo: { status?: string; url?: string },
    tab: { url?: string },
  ) => void;
}

describe("keepalive-port disconnect resolves a paused scraper (tasks 2.1, 2.4)", () => {
  it("stops the paused scraper when the panel's keepalive port disconnects; loop exits", async () => {
    vi.useFakeTimers();
    const port = makeFakePort();
    mockChromeRuntimeConnect.mockReturnValue(port);
    mockChromeTabsGet.mockResolvedValue({ url: ORIGINAL_URL });

    const scraper = createScraper();
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    setCurrentScraper(4210, scraper);
    createKeepalivePort(4210);
    const disconnectCalls = port.onDisconnect.addListener.mock.calls;
    const fireDisconnect = disconnectCalls[
      disconnectCalls.length - 1
    ][0] as () => void;

    scraper.pause();
    const done = scraper.processQueue(
      4210,
      { addFile: vi.fn() } as any,
      vi.fn(),
    );
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false); // paused and waiting

    // Simulated panel close → SW-side port onDisconnect
    fireDisconnect();
    await vi.advanceTimersByTimeAsync(10);

    // Pause wait resolved well before the watchdog bound — the loop exited
    expect(settled).toBe(true);
    expect(scraper["isStopped"]).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // watchdog cleared, no leak
    // The queued page was never scraped — no capture ran
    expect(mockChromeScriptingExecuteScript).not.toHaveBeenCalled();
    // Dead port forgotten — a reopened panel creates a fresh one
    expect(getKeepalivePort(4210)).toBeNull();

    // No indefinitely-pending processQueue
    await expect(done).resolves.toBe("");
  });

  it("handleKeepaliveDisconnect is idempotent (not paused / already stopped)", () => {
    const scraper = createScraper();
    // No pause in flight — disconnect must be a no-op (panel reopened race)
    expect(() => scraper.handleKeepaliveDisconnect()).not.toThrow();
    expect(scraper["isStopped"]).toBe(false);

    // Paused → disconnect stops; a second disconnect is still a no-op
    scraper.pause();
    scraper.handleKeepaliveDisconnect();
    expect(scraper["isStopped"]).toBe(true);
    expect(() => scraper.handleKeepaliveDisconnect()).not.toThrow();

    // resume() after a disconnect-stop is an idempotent no-op
    expect(() => scraper.resume()).not.toThrow();
    expect(scraper["isStopped"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Paused-state watchdog (task 2.5)
// ---------------------------------------------------------------------------

describe("paused-state watchdog (task 2.5)", () => {
  it("stops the scraper when the pause outlives the watchdog bound", async () => {
    vi.useFakeTimers();
    mockChromeTabsGet.mockResolvedValue({ url: ORIGINAL_URL });

    const scraper = createScraper();
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    // Pause with no resume and no disconnect
    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    let settled = false;
    void done.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(PAUSED_WATCHDOG_MS - 1);
    expect(settled).toBe(false); // still paused just before the bound

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true); // watchdog stopped it; loop exited
    expect(scraper["isStopped"]).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // watchdog consumed, nothing leaked
    await expect(done).resolves.toBe("");
  });

  it("continues normally when resumed before the bound (watchdog cleared)", async () => {
    vi.useFakeTimers();
    mockChromeTabsGet.mockResolvedValue({ url: ORIGINAL_URL });

    const scraper = createScraper();
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);

    // Reopened panel resumes in time
    scraper.resume();

    // Advance far past the ORIGINAL watchdog deadline — must not stop us
    await vi.advanceTimersByTimeAsync(PAUSED_WATCHDOG_MS + 10_000);

    const text = await done;
    expect(scraper["isStopped"]).toBe(false);
    expect(text).toContain("page text"); // the queued page was scraped
    expect(vi.getTimerCount()).toBe(0); // no stray watchdog left behind
  });

  it("bounds a pause in the external phase too (shared mechanism)", async () => {
    vi.useFakeTimers();
    mockChromeTabsGet.mockResolvedValue({ url: ORIGINAL_URL });

    const scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
      includeExternal: true,
    });
    await scraper.addToQueue({
      url: "https://other.org/page",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    await vi.advanceTimersByTimeAsync(PAUSED_WATCHDOG_MS + 10);

    expect(scraper["isStopped"]).toBe(true);
    await expect(done).resolves.toBe("");
  });
});

// ---------------------------------------------------------------------------
// Navigation completion matching (tasks 4.1, 4.2)
// ---------------------------------------------------------------------------

/** Call the private navigateAndWait without scraping a whole page. */
function navigate(scraper: LinkedPageScraper, url: string): Promise<string> {
  return (
    scraper as unknown as {
      navigateAndWait: (tabId: number, url: string) => Promise<string>;
    }
  ).navigateAndWait(1, url);
}

/** Let pending promise jobs run under fake timers. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("navigation completion matching (tasks 4.1, 4.2)", () => {
  it("normalizes URLs: hash-insensitive, query and origin kept", () => {
    expect(normalizeNavigationUrl("https://example.com/a?x=1#frag")).toBe(
      normalizeNavigationUrl("https://example.com/a?x=1"),
    );
    expect(normalizeNavigationUrl("https://example.com/a")).not.toBe(
      normalizeNavigationUrl("https://example.com/a?x=1"),
    );
    expect(normalizeNavigationUrl("https://other.com/a")).not.toBe(
      normalizeNavigationUrl("https://example.com/a"),
    );
    // Unparseable input passes through (compare falls back to inequality)
    expect(normalizeNavigationUrl("not a url")).toBe("not a url");
  });

  it("does NOT resolve on a stale completion from the previous page", async () => {
    vi.useFakeTimers();
    mockChromeTabsUpdate.mockResolvedValue(undefined);

    const scraper = createScraper();
    const p = navigate(scraper, "https://example.com/about");
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    const listener = lastOnUpdatedListener();

    // Old page (original URL) delivers a late completion for the same tab
    listener(1, { status: "complete" }, { url: ORIGINAL_URL });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);
    expect(mockChromeTabsOnUpdated.removeListener).not.toHaveBeenCalled();

    // The requested page completes → the wait resolves with the final URL
    listener(1, { status: "complete" }, { url: "https://example.com/about" });
    await expect(p).resolves.toBe("https://example.com/about");
  });

  it("resolves with the final URL when the requested page completes (hash-insensitive)", async () => {
    vi.useFakeTimers();
    mockChromeTabsUpdate.mockResolvedValue(undefined);

    const scraper = createScraper();
    const p = navigate(scraper, "https://example.com/about");
    const listener = lastOnUpdatedListener();

    listener(1, { status: "loading" }, { url: "https://example.com/about" });
    // Hash-only difference (anchor scroll) must not disqualify the completion
    listener(
      1,
      { status: "complete" },
      { url: "https://example.com/about#section" },
    );

    await expect(p).resolves.toBe("https://example.com/about#section");
    expect(mockChromeTabsOnUpdated.removeListener).toHaveBeenCalledWith(
      listener,
    );
  });

  it("accepts a differing completion only AFTER the target was seen loading (D4 fallback)", async () => {
    vi.useFakeTimers();
    mockChromeTabsUpdate.mockResolvedValue(undefined);

    const scraper = createScraper();
    const p = navigate(scraper, "https://example.com/about");
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    const listener = lastOnUpdatedListener();

    // Redirect landing WITHOUT the target ever loading → ignored
    listener(1, { status: "complete" }, { url: "https://example.com/jump" });
    await flush();
    expect(resolved).toBe(false);

    // Target seen loading, then a client-side redirect lands elsewhere
    listener(1, { status: "loading" }, { url: "https://example.com/about" });
    listener(1, { status: "complete" }, { url: "https://example.com/landing" });
    await expect(p).resolves.toBe("https://example.com/landing");
  });

  it("does not treat a different query string as the target (paginated stale completion)", async () => {
    vi.useFakeTimers();
    mockChromeTabsUpdate.mockResolvedValue(undefined);

    const scraper = createScraper();
    const p = navigate(scraper, "https://example.com/about?page=2");
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    const listener = lastOnUpdatedListener();

    // Previous page of the same path (differing query) must not resolve
    listener(
      1,
      { status: "complete" },
      { url: "https://example.com/about?page=1" },
    );
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false);

    listener(
      1,
      { status: "complete" },
      { url: "https://example.com/about?page=2" },
    );
    await expect(p).resolves.toBe("https://example.com/about?page=2");
  });

  it("still rejects with the navigation timeout when no qualifying completion arrives", async () => {
    vi.useFakeTimers();
    mockChromeTabsUpdate.mockResolvedValue(undefined);

    const scraper = createScraper(); // pageTimeout: 5000
    const p = navigate(scraper, "https://example.com/about");
    const listener = lastOnUpdatedListener();

    // Only a stale completion arrives
    listener(1, { status: "complete" }, { url: ORIGINAL_URL });

    // Attach the rejection handler before the timer fires
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).rejects.toThrow("Navigation timeout after 5000ms");
  });

  it("a stale completion never leads to a capture for the job (processQueue level)", async () => {
    vi.useFakeTimers();
    mockChromeTabsUpdate.mockResolvedValue(undefined);
    mockChromeTabsGet.mockResolvedValue({ url: ORIGINAL_URL });

    const scraper = createScraper();
    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    const messages: unknown[] = [];
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, (m) =>
      messages.push(m),
    );
    await flush();
    const listener = lastOnUpdatedListener();

    // Stale completion from the previous page — wait keeps going, then the
    // navigation timeout marks the job failed. No scroll/capture may run.
    listener(1, { status: "complete" }, { url: ORIGINAL_URL });
    await vi.advanceTimersByTimeAsync(5000);
    await done;

    expect(mockChromeScriptingExecuteScript).not.toHaveBeenCalled();
    expect(messages).toContain("Failed to scrape: https://example.com/about");
  });
});

// ---------------------------------------------------------------------------
// DOM capture timer hygiene (tasks 5.1, 5.2)
// ---------------------------------------------------------------------------

describe("DOM capture timer hygiene (tasks 5.1, 5.2)", () => {
  it("winning capturePageDOM clears the pending timeout", async () => {
    vi.useFakeTimers();
    mockChromeScriptingExecuteScript.mockResolvedValue([
      { result: "<html></html>" },
    ]);

    const scraper = createScraper();
    const html = await (
      scraper as unknown as { capturePageDOM: (t: number) => Promise<string> }
    ).capturePageDOM(1);

    expect(html).toBe("<html></html>");
    expect(vi.getTimerCount()).toBe(0); // no timer left pending
  });

  it("timed-out capturePageDOM rejects exactly once and leaves no re-firing timer", async () => {
    vi.useFakeTimers();
    mockChromeScriptingExecuteScript.mockReturnValue(
      new Promise(() => {
        /* never settles */
      }),
    );

    const scraper = createScraper();
    const p = (
      scraper as unknown as { capturePageDOM: (t: number) => Promise<string> }
    ).capturePageDOM(1);
    let rejections = 0;
    p.catch(() => {
      rejections++;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).rejects.toThrow("DOM capture timeout");
    await flush();
    expect(rejections).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // No re-firing timer: advancing further surfaces nothing new
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("winning capturePageDOMChunks clears the pending timeout", async () => {
    vi.useFakeTimers();
    mockChromeScriptingExecuteScript.mockResolvedValue([
      {
        result: {
          skeleton: "<html><head></head><body></body></html>",
          bodyChildren: ["<div>x</div>"],
        },
      },
    ]);

    const scraper = createScraper();
    const chunks = await (
      scraper as unknown as {
        capturePageDOMChunks: (t: number) => Promise<string[]>;
      }
    ).capturePageDOMChunks(1);

    expect(chunks.length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("timed-out capturePageDOMChunks rejects and leaves no re-firing timer", async () => {
    vi.useFakeTimers();
    mockChromeScriptingExecuteScript.mockReturnValue(
      new Promise(() => {
        /* never settles */
      }),
    );

    const scraper = createScraper();
    const p = (
      scraper as unknown as {
        capturePageDOMChunks: (t: number) => Promise<string[]>;
      }
    ).capturePageDOMChunks(1);
    let rejections = 0;
    p.catch(() => {
      rejections++;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p).rejects.toThrow("DOM chunk capture timeout");
    await flush();
    expect(rejections).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

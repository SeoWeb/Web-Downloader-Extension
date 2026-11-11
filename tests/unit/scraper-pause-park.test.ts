/**
 * Tests for the true pause + parked state (multipage-download-fixes D2,
 * tasks 4.1–4.6).
 *
 * The OLD contract bounded a pause: PAUSED_WATCHDOG_MS (60 s) self-stopped
 * the scraper and a keepalive-port disconnect while paused also stopped it.
 * The NEW contract (design D2): pause holds indefinitely — SCRAPING →
 * PAUSED → PARKED — and only an explicit Resume or Stop lifts it. Pausing
 * releases the tab immediately; Resume re-acquires one. A worker death while
 * paused parks the download (checkpoint phase `paused` + queue snapshot in
 * chrome.storage.session) instead of stopping/finalizing it.
 *
 * The first test bite-proofs the watchdog removal: it runs a pause past the
 * old 60 s bound with fake timers and asserts the scraper is still waiting
 * (at HEAD it self-stops; after the fix it holds — the verbatim pre-fix
 * failure is recorded in the change report).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinkedPageScraper } from "../../src/background/linked-page-scraper";
import { AssetRegistry } from "../../src/background/asset-registry";
import { serverClient } from "../../src/background/server-client";
import {
  writeCheckpoint,
  readCheckpoint,
} from "../../src/background/download-checkpoint";
import {
  readScraperSnapshot,
  clearScraperSnapshot,
} from "../../src/background/scraper-snapshot";
import {
  createKeepalivePort,
  getKeepalivePort,
} from "../../src/background/download-state";
import { setCurrentScraper } from "../../src/background/scraper-state";

// ---------------------------------------------------------------------------
// Mocks (urlUtils is NOT mocked: asset-registry reads buildArchivePath via
// `import * as urlUtils` and a partial mock breaks it — see
// linked-page-scraper-asset-gating.test.ts)
// ---------------------------------------------------------------------------

const mockChromeTabsGet = vi.fn();
const mockChromeTabsUpdate = vi.fn();
const mockChromeTabsCreate = vi.fn();
const mockChromeTabsOnUpdated = {
  addListener: vi.fn(),
  removeListener: vi.fn(),
};
const mockChromeScriptingExecuteScript = vi.fn();
const mockChromeRuntimeConnect = vi.fn();

// In-memory chrome.storage.session (same pattern as download-checkpoint.test.ts)
let storageSession: Map<string, unknown>;

Object.defineProperty(globalThis, "chrome", {
  value: {
    tabs: {
      get: mockChromeTabsGet,
      update: mockChromeTabsUpdate,
      create: mockChromeTabsCreate,
      onUpdated: mockChromeTabsOnUpdated,
    },
    scripting: {
      executeScript: mockChromeScriptingExecuteScript,
    },
    runtime: {
      connect: mockChromeRuntimeConnect,
    },
    storage: {
      session: {
        get: async (keys?: string | string[] | null) => {
          if (keys === null || keys === undefined) {
            return Object.fromEntries(storageSession);
          }
          const wanted = typeof keys === "string" ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const k of wanted) {
            if (storageSession.has(k)) out[k] = storageSession.get(k);
          }
          return out;
        },
        set: async (objs: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(objs)) storageSession.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          for (const k of typeof keys === "string" ? [keys] : keys) {
            storageSession.delete(k);
          }
        },
      },
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
    finalizeSession: vi.fn(),
    scrapeComplete: vi.fn(),
    getSessionStatus: vi.fn(),
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

// ---------------------------------------------------------------------------

const ORIGINAL_URL = "https://example.com/start";
const PAGE_1 = "https://example.com/about";
const PAGE_2 = "https://example.com/contact";
const PAGE_3 = "https://example.com/blog";
const SESSION_ID = "sess-park-1";

/** The old bounded-watchdog period, kept only as a test threshold. */
const OLD_PAUSED_WATCHDOG_MS = 60_000;

/** The tab's current URL — mutations mirror what tabs.update did, so
 *  chrome.tabs.get observes the same state a real browser would. */
let currentTabUrl = ORIGINAL_URL;

function createScraper(sessionId?: string): LinkedPageScraper {
  return new LinkedPageScraper(new AssetRegistry(), {
    maxPages: 10,
    delayBetweenPages: 0,
    pageTimeout: 5000,
    ...(sessionId ? { serverSessionId: sessionId } : {}),
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

/**
 * Immediate navigation for every URL. The completion carries the tab id the
 * navigation targeted (the scraper ignores completions for other tabs) and
 * `currentTabUrl` tracks the navigation, so tabs.get reports the scraped page
 * (what restoreOriginalPage sees in a real browser).
 */
function mockImmediateNavigation() {
  mockChromeTabsUpdate.mockImplementation((tabId: any, opts: any) => {
    currentTabUrl = opts.url;
    const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
    const listener = calls[calls.length - 1]?.[0];
    if (listener) {
      setTimeout(
        () => listener(tabId, { status: "complete" }, { url: opts.url }),
        0,
      );
    }
    return Promise.resolve();
  });
  mockChromeTabsGet.mockImplementation(async (tabId: number) => ({
    id: tabId,
    url: currentTabUrl,
  }));
}

/** Flush pending promise jobs under fake timers. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Every update({ url }) target the scraper navigated to. */
function navigatedUrls(): string[] {
  return mockChromeTabsUpdate.mock.calls
    .map((c) => (c[1] as any)?.url)
    .filter((u) => typeof u === "string");
}

beforeEach(() => {
  vi.clearAllMocks();
  storageSession = new Map();
  currentTabUrl = ORIGINAL_URL;
  mockEmptyPage();
  mockImmediateNavigation();
});

afterEach(async () => {
  vi.useRealTimers();
  await clearScraperSnapshot(undefined, { all: true });
});

// ---------------------------------------------------------------------------
// Task 4.1 — the pause holds past the old 60 s watchdog bound
// ---------------------------------------------------------------------------

describe("true pause (task 4.1 — watchdog removal)", () => {
  it("pause held beyond 60 s is NOT self-stopped (waits for resume/stop)", async () => {
    vi.useFakeTimers();
    const scraper = createScraper();
    await scraper.addToQueue({
      url: PAGE_1,
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    let settled = false;
    void done.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false); // paused and waiting

    // Advance well past the old PAUSED_WATCHDOG_MS (60 s) bound — twice over.
    // OLD behavior: the watchdog fires at 60 s, stops the scraper, and the
    // loop exits. NEW behavior: the pause holds indefinitely.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    expect(scraper["isStopped"]).toBe(false);

    // An explicit Resume still lifts the pause and the loop continues
    scraper.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(scraper["isStopped"]).toBe(false);
    expect(scraper.getStats().succeeded).toBe(1); // the queued page was scraped
  });
});

// ---------------------------------------------------------------------------
// Task 4.1 — disconnect while paused parks instead of stopping
// ---------------------------------------------------------------------------

describe("keepalive disconnect while paused parks (task 4.1)", () => {
  function makeFakePort() {
    return {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  it("disconnect while paused: no stop, no finalize; snapshot+paused checkpoint remain; scraper stays resumable", async () => {
    vi.useFakeTimers();
    // A real download context: checkpoint + session-scoped scraper
    await writeCheckpoint({
      phase: "scraping",
      serverSessionId: SESSION_ID,
      tabId: 1,
      tabUrl: ORIGINAL_URL,
    });
    const scraper = createScraper(SESSION_ID);
    await scraper.addToQueue({
      url: PAGE_1,
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });
    setCurrentScraper(1, scraper);

    const port = makeFakePort();
    mockChromeRuntimeConnect.mockReturnValue(port);
    createKeepalivePort(1);
    const disconnectCalls = port.onDisconnect.addListener.mock.calls;
    const fireDisconnect = disconnectCalls[
      disconnectCalls.length - 1
    ][0] as () => void;

    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false); // paused and waiting

    // Panel closes → keepalive port disconnects on the SW side
    fireDisconnect();
    await flush();
    expect(getKeepalivePort(1)).toBeNull(); // dead port forgotten

    // The pause PERSISTS: no stop, no finalize, loop still blocked
    expect(settled).toBe(false);
    expect(scraper["isStopped"]).toBe(false);
    await vi.advanceTimersByTimeAsync(OLD_PAUSED_WATCHDOG_MS);
    expect(settled).toBe(false); // still no watchdog self-stop either
    expect(serverClient.finalizeSession).not.toHaveBeenCalled(); // nothing finalized

    // The park state is on disk: snapshot + paused checkpoint
    const snapshot = await readScraperSnapshot(SESSION_ID);
    expect(snapshot?.serverSessionId).toBe(SESSION_ID);
    const checkpoint = await readCheckpoint(SESSION_ID);
    expect(checkpoint?.phase).toBe("paused");

    // The scraper object is intact and resumable — a reopened panel's
    // Resume reaches it and the loop completes normally
    scraper.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(scraper.getStats().succeeded).toBe(1); // the queued page was scraped
    expect(scraper["isStopped"]).toBe(false);
    // Park consumed on resume
    expect(await readScraperSnapshot(SESSION_ID)).toBeNull();
    expect((await readCheckpoint(SESSION_ID))?.phase).toBe("scraping");
  });
});

// ---------------------------------------------------------------------------
// Tasks 4.2 + 4.3 + 4.4 — tab release, snapshot round-trip, checkpoint phase
// ---------------------------------------------------------------------------

/**
 * Drive a 3-page queue to the paused hold: pages 1 and 2 complete, the
 * pause is issued while page 2 is still processing (takes effect after the
 * current page completes), and the loop blocks at page 3's advancement
 * check — exactly the moment the snapshot is frozen.
 */
async function pauseWithTwoPagesDone(): Promise<{
  scraper: LinkedPageScraper;
  done: Promise<string>;
}> {
  vi.useFakeTimers();
  await writeCheckpoint({
    phase: "scraping",
    serverSessionId: SESSION_ID,
    tabId: 1,
    tabUrl: ORIGINAL_URL,
  });

  // Defer page 2's navigation completion so the pause can be issued
  // mid-processing (the pause takes effect after page 2 COMPLETES).
  let releasePage2: (tabId: number, url: string) => void = () => {};
  const page2Completion = new Promise<void>((resolve) => {
    releasePage2 = (tabId: number, url: string) => {
      currentTabUrl = url;
      const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
      const listener = calls[calls.length - 1]?.[0];
      listener?.(tabId, { status: "complete" }, { url });
      resolve();
    };
  });
  mockChromeTabsUpdate.mockImplementation((tabId: any, opts: any) => {
    if (opts.url === PAGE_2) {
      return new Promise<void>(() => {
        // completion held until released
        void page2Completion;
        void releasePage2;
      });
    }
    currentTabUrl = opts.url;
    const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
    const listener = calls[calls.length - 1]?.[0];
    if (listener) {
      setTimeout(
        () => listener(tabId, { status: "complete" }, { url: opts.url }),
        0,
      );
    }
    return Promise.resolve();
  });

  const scraper = createScraper(SESSION_ID);
  for (const url of [PAGE_1, PAGE_2, PAGE_3]) {
    await scraper.addToQueue({
      url,
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });
  }

  const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());

  // Page 1 completes fully
  await vi.advanceTimersByTimeAsync(50);
  expect(scraper.getStats().succeeded).toBe(1);

  // Page 2 starts navigating and hangs — issue the pause NOW
  scraper.pause();
  releasePage2(1, PAGE_2);
  // Page 2 completes (uploads flush), then the loop blocks at page 3's
  // advancement check — the pause hold, with the snapshot frozen there.
  await vi.advanceTimersByTimeAsync(50);
  expect(scraper.getStats().succeeded).toBe(2);
  expect(scraper["isPaused"]).toBe(true);

  // Give the async snapshot/checkpoint writes their microtasks
  await flush();
  return { scraper, done };
}

describe("pause takes effect after the current page completes (tasks 4.1–4.4)", () => {
  it("blocks before page 3, releases the tab, freezes the snapshot, and flips the checkpoint to paused", async () => {
    const { scraper, done } = await pauseWithTwoPagesDone();

    // Loop is blocked — page 3 was never navigated
    expect(navigatedUrls()).not.toContain(PAGE_3);

    // (task 4.2) The tab was RELEASED on pause: restored to the original page
    expect(mockChromeTabsUpdate).toHaveBeenCalledWith(1, { url: ORIGINAL_URL });

    // (task 4.4) Checkpoint phase `paused` while the pause is held
    const checkpoint = await readCheckpoint(SESSION_ID);
    expect(checkpoint?.phase).toBe("paused");
    expect(checkpoint?.previousPhase).toBe("scraping");

    // (task 4.3) The frozen snapshot matches the loop state at the hold
    const snapshot = await readScraperSnapshot(SESSION_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.serverSessionId).toBe(SESSION_ID);
    expect(snapshot?.tabId).toBe(1);
    expect(snapshot?.tabUrl).toBe(ORIGINAL_URL);
    expect(snapshot?.phase).toBe("internal");
    expect(snapshot?.internalQueue.map((j) => j.url)).toEqual([PAGE_3]);
    expect(snapshot?.externalQueue).toEqual([]);
    expect(snapshot?.visitedUrls.sort()).toEqual([PAGE_1, PAGE_2].sort());
    expect(snapshot?.successCount).toBe(2);
    expect(snapshot?.failCount).toBe(0);
    expect(snapshot?.previousCheckpointPhase).toBe("scraping");
    expect(snapshot?.options.maxPages).toBe(10);
    expect(snapshot?.options.extractText).toBe(true);
    expect(snapshot?.truncated).toBeFalsy();

    // (task 4.1) The pause holds indefinitely — no self-stop
    await vi.advanceTimersByTimeAsync(OLD_PAUSED_WATCHDOG_MS + 1_000);
    expect(scraper["isStopped"]).toBe(false);
    expect(navigatedUrls()).not.toContain(PAGE_3); // still blocked

    // Resume → page 3 is scraped and the park state is consumed
    scraper.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(navigatedUrls()).toContain(PAGE_3);
    expect(scraper.getStats().succeeded).toBe(3); // pages 1-2 + resumed page 3
    expect(await readScraperSnapshot(SESSION_ID)).toBeNull();
    expect((await readCheckpoint(SESSION_ID))?.phase).toBe("scraping");
    expect((await readCheckpoint(SESSION_ID))?.previousPhase).toBeUndefined();
  });

  it("stop while paused consumes the snapshot and exits the loop (task 4.3: cleared on stop)", async () => {
    const { scraper, done } = await pauseWithTwoPagesDone();
    expect((await readScraperSnapshot(SESSION_ID))?.internalQueue).toHaveLength(
      1,
    );

    scraper.stop();
    await vi.advanceTimersByTimeAsync(50);
    // Pages 1-2 completed before the pause; page 3 is not scraped
    await done;
    expect(scraper.getStats().succeeded).toBe(2);
    expect(scraper["isStopped"]).toBe(true);
    // Snapshot cleared + checkpoint phase restored on stop
    expect(await readScraperSnapshot(SESSION_ID)).toBeNull();
    expect((await readCheckpoint(SESSION_ID))?.phase).toBe("scraping");
    // Page 3 was never scraped
    expect(navigatedUrls()).not.toContain(PAGE_3);
  });
});

// ---------------------------------------------------------------------------
// Task 4.2 — tab release on pause, re-acquire on resume
// ---------------------------------------------------------------------------

describe("tab release + re-acquire (task 4.2)", () => {
  it("restores the original page when the pause takes effect (tab not held hostage)", async () => {
    // Two pages: pause is issued while page 1 is mid-processing; when it
    // completes, the hold at page 2's advancement check releases the tab.
    vi.useFakeTimers();
    let releasePage1: (tabId: number, url: string) => void = () => {};
    const page1Completion = new Promise<void>((resolve) => {
      releasePage1 = (tabId: number, url: string) => {
        currentTabUrl = url;
        const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
        const listener = calls[calls.length - 1]?.[0];
        listener?.(tabId, { status: "complete" }, { url });
        resolve();
      };
    });
    mockChromeTabsUpdate.mockImplementation((tabId: any, opts: any) => {
      if (opts.url === PAGE_1) {
        return new Promise<void>(() => void page1Completion);
      }
      currentTabUrl = opts.url;
      const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
      const listener = calls[calls.length - 1]?.[0];
      if (listener) {
        setTimeout(
          () => listener(tabId, { status: "complete" }, { url: opts.url }),
          0,
        );
      }
      return Promise.resolve();
    });

    const scraper = createScraper(SESSION_ID);
    for (const url of [PAGE_1, PAGE_2]) {
      await scraper.addToQueue({
        url,
        depth: 1,
        parentUrl: ORIGINAL_URL,
        status: "queued",
      });
    }

    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    await flush();
    expect(mockChromeTabsUpdate).toHaveBeenCalledWith(1, { url: PAGE_1 });

    // Tab navigation is still pending; pause is issued mid-processing and
    // page 1 is released to complete
    expect(currentTabUrl).toBe(ORIGINAL_URL); // navigation not completed yet
    scraper.pause();
    releasePage1(1, PAGE_1);
    await vi.advanceTimersByTimeAsync(50);
    expect(scraper["isPaused"]).toBe(true);

    // The pause hold restored the ORIGINAL page — no scraped page held
    expect(mockChromeTabsUpdate).toHaveBeenCalledWith(1, { url: ORIGINAL_URL });
    expect(currentTabUrl).toBe(ORIGINAL_URL);

    scraper.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
  });

  it("resume re-acquires the original tab when it still exists (same id reused)", async () => {
    vi.useFakeTimers();
    const scraper = createScraper(SESSION_ID);
    await scraper.addToQueue({
      url: PAGE_1,
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    await flush();

    // Original tab still alive on resume → reused, no tab created
    scraper.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(scraper.getStats().succeeded).toBe(1); // the queued page was scraped
    expect(mockChromeTabsCreate).not.toHaveBeenCalled();
    expect(navigatedUrls()).toContain(PAGE_1); // scraped on tab 1
  });

  it("resume re-acquires by CREATING a background tab when the original is gone (never assumes the old tabId is alive)", async () => {
    vi.useFakeTimers();
    const scraper = createScraper(SESSION_ID);
    await scraper.addToQueue({
      url: PAGE_1,
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    await flush();

    // The original tab was closed while paused
    mockChromeTabsGet.mockRejectedValue(new Error("No tab with id: 1"));
    mockChromeTabsCreate.mockResolvedValue({ id: 99, url: ORIGINAL_URL });

    scraper.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    // A background tab was created and the scrape ran THERE
    expect(mockChromeTabsCreate).toHaveBeenCalledWith({
      url: ORIGINAL_URL,
      active: false,
    });
    const navCalls = mockChromeTabsUpdate.mock.calls.filter(
      (c) => (c[1] as any)?.url === PAGE_1,
    );
    expect(navCalls).toHaveLength(1);
    expect(navCalls[0][0]).toBe(99); // navigated the NEW tab
    expect(scraper.getStats().succeeded).toBe(1); // the queued page was scraped
  });
});

// ---------------------------------------------------------------------------
// Task 4.5/4.6 — resume-from-park seeding (no re-scraping of visited pages)
// ---------------------------------------------------------------------------

describe("resume-from-park seeding (tasks 4.5–4.6)", () => {
  it("a scraper spawned from the snapshot continues WITHOUT re-scraping visited pages, in queue order", async () => {
    vi.useFakeTimers();
    const visited = [PAGE_1, PAGE_2, "https://example.com/failed-page"];
    const snapshot = {
      version: 1,
      serverSessionId: SESSION_ID,
      tabId: 1,
      tabUrl: ORIGINAL_URL,
      phase: "internal" as const,
      internalQueue: [
        { url: PAGE_3, depth: 1, parentUrl: ORIGINAL_URL },
        { url: "https://example.com/last", depth: 1, parentUrl: ORIGINAL_URL },
      ],
      externalQueue: [
        { url: "https://other.org/link", depth: 1, parentUrl: ORIGINAL_URL },
      ],
      visitedUrls: visited,
      successCount: 2,
      failCount: 1,
      options: {
        maxPages: 10,
        delayBetweenPages: 0,
        includeExternal: true,
        pageTimeout: 5000,
        downloadImages: true,
        downloadAssets: true,
        downloadDocuments: true,
        extractText: true,
      },
      previousCheckpointPhase: "scraping",
      timestamp: Date.now(),
    };

    const scraper = LinkedPageScraper.fromSnapshot(
      snapshot,
      new AssetRegistry(),
    );

    // Seeded state matches the snapshot
    expect(scraper.getStats()).toEqual({
      total: 3,
      succeeded: 2,
      failed: 1,
      pending: 3,
    });
    expect(scraper["options"].serverSessionId).toBe(SESSION_ID);
    expect(scraper["options"].includeExternal).toBe(true);

    // Continue the loop — external phase ends on the ORIGINAL page restore
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    // Only the REMAINING queue was scraped — visited pages never navigated
    const navigated = navigatedUrls();
    expect(navigated).toEqual([
      PAGE_3,
      "https://example.com/last",
      "https://other.org/link",
      ORIGINAL_URL, // end-of-loop restore
    ]);
    for (const url of visited) {
      expect(navigated).not.toContain(url);
    }
  });

  it("a restored scraper seeded from the SNAPSHOT ON DISK skips the visited set (round-trip through storage)", async () => {
    const { scraper } = await pauseWithTwoPagesDone();
    const stored = await readScraperSnapshot(SESSION_ID);
    expect(stored).not.toBeNull();

    // Simulate the worker-death respawn: a NEW scraper instance seeded from
    // the persisted snapshot.
    const respawned = LinkedPageScraper.fromSnapshot(
      stored!,
      new AssetRegistry(),
    );
    expect(respawned["scrapeUrls"].has(PAGE_1)).toBe(true);
    expect(respawned["scrapeUrls"].has(PAGE_2)).toBe(true);
    expect(respawned["scrapeUrls"].has(PAGE_3)).toBe(true);

    const navigationsBeforeRespawn = navigatedUrls().length;
    const done = respawned.processQueue(
      1,
      { addFile: vi.fn() } as any,
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    // Only the REMAINING queue was scraped by the respawned scraper
    const delta = navigatedUrls().slice(navigationsBeforeRespawn);
    expect(delta).toEqual([PAGE_3, ORIGINAL_URL]); // PAGE_3 + end-of-loop restore
    expect(delta).not.toContain(PAGE_1);
    expect(delta).not.toContain(PAGE_2);
    void scraper;
  });
});

// ---------------------------------------------------------------------------
// Task 4.3 — snapshot truncation beyond the 5,000 cap
// ---------------------------------------------------------------------------

describe("snapshot truncation marker beyond 5,000 queued URLs (task 4.3)", () => {
  it("caps the persisted queues at 5,000 entries total and records truncated: true", async () => {
    vi.useFakeTimers();
    await writeCheckpoint({
      phase: "scraping",
      serverSessionId: SESSION_ID,
      tabId: 1,
      tabUrl: ORIGINAL_URL,
    });

    const scraper = createScraper(SESSION_ID);
    // Bypass addToQueue's maxPages clamp — a huge discovered queue is the
    // truncation scenario itself.
    const internalQueue = scraper["internalQueue"] as any[];
    for (let i = 0; i < 6000; i++) {
      internalQueue.push({
        url: `https://example.com/p${i}`,
        depth: 1,
        parentUrl: ORIGINAL_URL,
        status: "queued",
      });
    }
    const externalQueue = scraper["externalQueue"] as any[];
    for (let i = 0; i < 50; i++) {
      externalQueue.push({
        url: `https://other.org/p${i}`,
        depth: 1,
        parentUrl: ORIGINAL_URL,
        status: "queued",
      });
    }

    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    await flush();

    const snapshot = await readScraperSnapshot(SESSION_ID);
    expect(snapshot?.truncated).toBe(true);
    // Internal-first cap: 5,000 combined entries, external overflow dropped
    expect(snapshot?.internalQueue).toHaveLength(5000);
    expect(snapshot?.externalQueue).toHaveLength(0);

    // A Stop still exits cleanly with the truncated park consumed
    scraper.stop();
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(scraper.getStats().succeeded).toBe(0); // stopped before any scrape
    expect(await readScraperSnapshot(SESSION_ID)).toBeNull();
  });

  it("a queue within the cap records NO truncation marker", async () => {
    vi.useFakeTimers();
    const scraper = createScraper(SESSION_ID);
    await scraper.addToQueue({
      url: PAGE_1,
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    scraper.pause();
    const done = scraper.processQueue(1, { addFile: vi.fn() } as any, vi.fn());
    await flush();

    const snapshot = await readScraperSnapshot(SESSION_ID);
    expect(snapshot?.truncated).toBeFalsy();
    expect(snapshot?.internalQueue).toHaveLength(1);

    scraper.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
  });
});

/**
 * Push rejection hygiene (design D6 / tasks 6.1–6.3).
 *
 * The background pushes progress/heartbeat/status messages to the side panel
 * through the fire-and-forget `sendMessage` callback (messageWorker's
 * addMessage → sendMessageToPanel). With the panel closed, every one of those
 * pushes rejects with "Receiving end does not exist". Before the fix the
 * returned promise was dropped at the call site, so each failed push surfaced
 * as an unhandled rejection in the service worker.
 *
 * Under test:
 * - invoking the `uploadQueue.onProgress` / `onSessionFull` wirings and both
 *   15 s heartbeat intervals with a REJECTING send produces no unhandled
 *   rejection (asserted via a process "unhandledRejection" spy) and does not
 *   throw into the download pipeline — the flow still completes;
 * - a SUCCESSFUL push behaves exactly as before (payload pinning).
 *
 * Mocking mirrors zero-content-abort.test.ts (main flow) and
 * resume-produces-uploads.test.ts (resume flow); the upload queue is a
 * controllable fake so the heartbeats can be fired deterministically with
 * fake timers.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

// ---------------------------------------------------------------------------
// Hoisted shared state — referenced by the vi.mock factories below (factories
// are hoisted above imports and may only touch vi.hoisted values).
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  type Progress = {
    totalCount: number;
    completedCount: number;
    failedCount: number;
    bytesUploaded: number;
    totalBytes: number;
  };
  const progress: Progress = {
    totalCount: 2,
    completedCount: 1,
    failedCount: 0,
    bytesUploaded: 128,
    totalBytes: 256,
  };
  // Fake upload queue the MAIN flow wires onProgress/onSessionFull onto.
  const mainQueue = {
    onProgress: null as ((p: Progress) => void) | null,
    onSessionFull: null as ((sessionId: string) => void) | null,
    cancel: vi.fn(),
    getResourceUrls: vi.fn(() => [] as string[]),
    getResourceCount: vi.fn(() => 2),
    getProgress: vi.fn((): Progress => progress),
    waitForAll: vi.fn(() => Promise.resolve()),
    isSessionFull: vi.fn(() => false),
  };
  // Fake queue instances created by the RESUME flow (new UploadQueue(...)).
  class FakeUploadQueue {
    onProgress: ((p: Progress) => void) | null = null;
    onSessionFull: ((sessionId: string) => void) | null = null;
    cancel = vi.fn();
    enqueue = vi.fn(async () => {});
    getResourceUrls = vi.fn(() => [] as string[]);
    getResourceCount = vi.fn(() => 2);
    getProgress = vi.fn((): Progress => progress);
    waitForAll = vi.fn(() => Promise.resolve());
    isSessionFull = vi.fn(() => false);
    constructor() {
      resumeQueues.push(this);
    }
  }
  const resumeQueues: FakeUploadQueue[] = [];
  return { mainQueue, resumeQueues, FakeUploadQueue };
});

// ---------------------------------------------------------------------------
// Mocks — download-core's collaborators (mirrors zero-content-abort.test.ts)
// ---------------------------------------------------------------------------

vi.mock("../../src/background/upload-queue", () => ({
  UploadQueue: h.FakeUploadQueue,
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
      createSession: vi.fn(async () => "session-push-hygiene"),
      uploadHtmlChunk: vi.fn(async () => {}),
      uploadFilenameMap: vi.fn(async () => {}),
      uploadContent: vi.fn(async () => {}),
      scrapeComplete: vi.fn(async () => {}),
      finalizeSession: vi.fn(async () => {}),
      getSessionStatus: vi.fn(async () => ({ status: "uploading" })),
    },
    assertSecureBaseUrl: vi.fn(),
    upgradeInsecureServerUrl: vi.fn((url: string) => url),
    ServerUnavailableError,
    AuthenticationError,
    AssemblyTimeoutError,
    HttpError,
  };
});

vi.mock("../../src/background/server-download", () => ({
  getServerDownloadHandler: vi.fn(() => ({
    downloadWithFallback: vi.fn(async () => ({})),
  })),
  AssemblyFailedError: class extends Error {},
}));

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
    images: [] as string[],
    css: [] as string[],
    js: [] as string[],
    links: [] as string[],
    documents: [] as string[],
    text: "",
  })),
}));
vi.mock("../../src/background/download-processors", () => ({
  processImages: vi.fn(async () => new Map()),
  processAssets: vi.fn(async () => new Map()),
  processDocuments: vi.fn(async () => new Map()),
  mergeFilenameMaps: vi.fn(
    (...maps: Array<Map<string, string> | undefined>) => {
      const merged = new Map<string, string>();
      for (const map of maps) {
        if (!map) continue;
        for (const [key, value] of map) {
          if (!merged.has(key)) merged.set(key, value);
        }
      }
      return merged;
    },
  ),
}));
vi.mock("../../src/background/linked-page-scraper", () => ({
  LinkedPageScraper: class {},
}));
// Real download-processors / linked-page-scraper (driven directly in the
// processor/scraper suites below) forward pushes to these handlers — keep
// them controllable fakes so no real fetch/upload runs.
vi.mock("../../src/background/fileHandlers", () => ({
  addCssFiles: vi.fn(async () => new Map<string, string>()),
  addJsFiles: vi.fn(async () => new Map<string, string>()),
  addImageFiles: vi.fn(async () => new Map<string, string>()),
  addDocumentFiles: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("../../src/background/storage/server-storage-adapter", () => ({
  ServerStorageAdapter: class {
    setSessionId() {}
    getUploadQueue() {
      return h.mainQueue;
    }
  },
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
  loadFilterOptions: vi.fn(async () => ({ alwaysAskWhereToSave: true })),
}));

// Spy on the liveness marks (wiring is verified in zero-content-abort.test.ts;
// here they just need to stay harmless).
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  downloadResources,
  resumeServerDownload,
} from "../../src/background/download-core";
import { serverClient } from "../../src/background/server-client";
import { stopScraping } from "../../src/background/scraper-state";
import { getResources } from "../../src/background/resources";
import { AssetRegistry } from "../../src/background/asset-registry";
import {
  addCssFiles,
  addJsFiles,
  addImageFiles,
  addDocumentFiles,
} from "../../src/background/fileHandlers";
import { requestQueue } from "../../src/utils/RequestQueue";
import type { RequestResult, ResponseSnapshot } from "../../src/types/queue";
import { RequestQueueError } from "../../src/types/queue";
import type { FilterOptions } from "../../src/types/filterTypes";
import type { LinkedPageScraperOptions } from "../../src/background/linked-page-scraper";

// tests/setup.cjs provides chrome.storage.local; downloadResources also
// creates a keepalive port (chrome.runtime.connect) at flow start.
(globalThis.chrome as { runtime?: unknown }).runtime = {
  connect: () => ({
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} },
    postMessage: () => {},
    disconnect: () => {},
  }),
};

// ---------------------------------------------------------------------------

const TAB_ID = 91;

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

/**
 * A send that mimics a closed panel: the real addMessage returns the
 * sendMessageToPanel promise regardless of its `void` annotation, and with
 * no receiver that promise rejects.
 *
 * Deliberately a PLAIN function, not vi.fn() — vitest's mock wrapper attaches
 * a handler to the promises returned by mocked functions, which would hide
 * exactly the dropped-rejection behavior this suite exists to catch.
 */
const rejectedPushes: Array<string | { key: string; options?: any }> = [];
const rejectingSend = (
  message: string | { key: string; options?: any },
): void => {
  rejectedPushes.push(message);
  return Promise.reject(new Error("Receiving end does not exist")) as void;
};

/**
 * Spy on Node's unhandled-rejection reporting. Attached per test (and
 * detached right after) so rejections from unrelated suites running in the
 * same worker can never leak into an assertion.
 */
function attachUnhandledRejectionSpy() {
  const reasons: unknown[] = [];
  const messages: string[] = [];
  const listener = (reason: unknown) => {
    reasons.push(reason);
    messages.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", listener);
  return {
    reasons,
    messages,
    detach() {
      process.off("unhandledRejection", listener);
    },
  };
}

/** Give Node's unhandled-rejection detection a few macrotask turns to fire. */
async function flushUnhandledRejections() {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let unhandled: ReturnType<typeof attachUnhandledRejectionSpy>;

beforeEach(() => {
  vi.clearAllMocks();
  rejectedPushes.length = 0;
  h.mainQueue.onProgress = null;
  h.mainQueue.onSessionFull = null;
  h.mainQueue.waitForAll.mockReset();
  h.mainQueue.waitForAll.mockResolvedValue(undefined);
  h.mainQueue.isSessionFull.mockReturnValue(false);
  h.resumeQueues.length = 0;
  vi.mocked(getResources).mockReturnValue({
    images: ["https://fixture.test/a.png"],
    css: [],
    js: [],
    links: [],
    documents: [],
    text: "",
  } as ReturnType<typeof getResources>);
  unhandled = attachUnhandledRejectionSpy();
});

afterEach(() => {
  unhandled.detach();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Main flow: onProgress / onSessionFull / fresh-flow heartbeat
// ---------------------------------------------------------------------------

describe("push rejection hygiene — main download flow", () => {
  it("onProgress + onSessionFull + heartbeat with a rejecting send: no unhandled rejection, download completes", async () => {
    // Park the flow inside the upload wait so the heartbeat is live.
    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    h.mainQueue.waitForAll.mockImplementation(() => waitGate);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const flow = downloadResources(
      "<html><body>page</body></html>",
      "https://fixture.test/page.html",
      downloadOptions(),
      rejectingSend,
      undefined,
      TAB_ID,
    );

    // Wait until the wiring ran and the flow is parked in waitForAll — the
    // heartbeat interval is armed just before that call.
    await vi.waitUntil(() => h.mainQueue.waitForAll.mock.calls.length > 0, {
      timeout: 5000,
    });

    // Both push wirings must have been installed on the queue.
    expect(h.mainQueue.onProgress).toBeTypeOf("function");
    expect(h.mainQueue.onSessionFull).toBeTypeOf("function");

    // Invoking the callbacks with a rejecting send must not throw into the
    // pipeline...
    expect(() =>
      h.mainQueue.onProgress!(h.mainQueue.getProgress()),
    ).not.toThrow();
    expect(() =>
      h.mainQueue.onSessionFull!("session-push-hygiene"),
    ).not.toThrow();
    // ...and onSessionFull's own behavior is untouched (stop the scraper).
    expect(stopScraping).toHaveBeenCalledWith(TAB_ID);

    // Fire the fresh-flow heartbeat (15 s cadence) while the send rejects.
    await vi.advanceTimersByTimeAsync(15_000);

    await flushUnhandledRejections();
    expect(unhandled.reasons).toEqual([]);
    expect(unhandled.messages).toEqual([]);

    // The download pipeline is unaffected by the failed pushes.
    releaseWait();
    await expect(flow).resolves.toBeUndefined();
    expect(serverClient.finalizeSession).toHaveBeenCalledWith(
      "session-push-hygiene",
    );
    const pushedKeys = rejectedPushes.map(
      (push) => (push as { key: string }).key,
    );
    expect(pushedKeys).toContain("status.complete");
  });

  it("pinning: successful pushes deliver the same payloads as the bare calls did", async () => {
    const send = vi.fn(); // resolves — panel connected

    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    h.mainQueue.waitForAll.mockImplementation(() => waitGate);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const flow = downloadResources(
      "<html><body>page</body></html>",
      "https://fixture.test/page.html",
      downloadOptions(),
      send,
      undefined,
      TAB_ID,
    );
    await vi.waitUntil(() => h.mainQueue.waitForAll.mock.calls.length > 0, {
      timeout: 5000,
    });

    // onProgress forwards the queue progress with the established mapping
    // (completedCount → completed, totalCount → total).
    h.mainQueue.onProgress!(h.mainQueue.getProgress());
    expect(send).toHaveBeenCalledWith({
      key: "status.uploadProgress",
      options: {
        completed: 1,
        total: 2,
        bytesUploaded: 128,
        totalBytes: 256,
      },
    });

    // onSessionFull still stops the scraper and pushes the notice.
    h.mainQueue.onSessionFull!("session-push-hygiene");
    expect(stopScraping).toHaveBeenCalledWith(TAB_ID);
    expect(send).toHaveBeenCalledWith({
      key: "status.sessionSizeLimitReached",
    });

    // The heartbeat pushes the same progress payload from getProgress().
    const pushesBeforeHeartbeat = send.mock.calls.filter(
      (call) => (call[0] as { key: string }).key === "status.uploadProgress",
    ).length;
    expect(pushesBeforeHeartbeat).toBe(1); // the manual onProgress push above
    await vi.advanceTimersByTimeAsync(15_000);
    const pushesAfterHeartbeat = send.mock.calls.filter(
      (call) => (call[0] as { key: string }).key === "status.uploadProgress",
    );
    expect(pushesAfterHeartbeat.length).toBe(2); // + exactly one heartbeat
    expect(pushesAfterHeartbeat[1][0]).toEqual({
      key: "status.uploadProgress",
      options: {
        completed: 1,
        total: 2,
        bytesUploaded: 128,
        totalBytes: 256,
      },
    });

    releaseWait();
    await expect(flow).resolves.toBeUndefined();
    expect(unhandled.reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resume flow: onProgress wiring + resume heartbeat
// ---------------------------------------------------------------------------

describe("push rejection hygiene — resume flow", () => {
  function resumeCheckpoint() {
    return {
      serverSessionId: "sess-resume-push",
      tabUrl: "https://fixture.test/page.html",
      tabId: undefined,
      phase: "uploading",
      resourceUrls: [
        {
          url: "https://fixture.test/a.png",
          path: "images/a.png",
          contentType: "image/png",
          size: 128,
        },
      ],
    };
  }

  it("resume onProgress + heartbeat with a rejecting send: no unhandled rejection, resume completes", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => ({
      ok: true,
      url,
      blob: async () =>
        new Blob([new Uint8Array(16)], { type: "application/octet-stream" }),
    })) as unknown as typeof fetch;

    let releaseWait!: () => void;
    new Promise<void>((resolve) => {
      releaseWait = resolve;
    });

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const flow = resumeServerDownload(resumeCheckpoint(), rejectingSend);

    try {
      // Wait until the resume created its queue and parked in waitForAll —
      // the heartbeat interval is armed just before that call.
      await vi.waitUntil(
        () =>
          h.resumeQueues.length > 0 &&
          h.resumeQueues[0].waitForAll.mock.calls.length > 0,
        { timeout: 5000 },
      );
      const queue = h.resumeQueues[0];
      expect(queue.onProgress).toBeTypeOf("function");

      // A rejecting push from the resume wiring must not throw...
      expect(() => queue.onProgress!(queue.getProgress())).not.toThrow();

      // ...and the resume heartbeat must not surface an unhandled rejection.
      await vi.advanceTimersByTimeAsync(15_000);

      await flushUnhandledRejections();
      expect(unhandled.reasons).toEqual([]);
      expect(unhandled.messages).toEqual([]);

      // The resume pipeline is unaffected by the failed pushes.
      releaseWait();
      await expect(flow).resolves.toBeUndefined();
      expect(serverClient.finalizeSession).toHaveBeenCalledWith(
        "sess-resume-push",
      );
    } finally {
      // Never leak the gate or the fetch stub if an assertion above throws.
      releaseWait();
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Download processors (tasks 6.2 spillover): the status pushes these functions
// fire around the file handlers go through the same fire-and-forget send.
// Driven via the REAL download-processors module (the mocks above exist for
// the download-core suites) over controllable fileHandlers fakes.
// ---------------------------------------------------------------------------

type RealProcessors = typeof import("../../src/background/download-processors");

async function realProcessors(): Promise<RealProcessors> {
  return vi.importActual<RealProcessors>(
    "../../src/background/download-processors",
  );
}

describe("push rejection hygiene — download processors", () => {
  const TAB_URL = "https://fixture.test/page.html";

  it("processImages/processAssets/processDocuments with a rejecting send: no unhandled rejection, results flow through", async () => {
    const { processImages, processAssets, processDocuments } =
      await realProcessors();
    const imageMap = new Map([["https://fixture.test/a.png", "images/a.png"]]);
    vi.mocked(addImageFiles).mockResolvedValue(imageMap);
    vi.mocked(addCssFiles).mockResolvedValue(
      new Map([["https://fixture.test/a.css", "styles/a.css"]]),
    );
    vi.mocked(addJsFiles).mockResolvedValue(
      new Map([["https://fixture.test/a.js", "scripts/a.js"]]),
    );
    vi.mocked(addDocumentFiles).mockResolvedValue(
      new Map([["https://fixture.test/a.pdf", "documents/a.pdf"]]),
    );
    const storage = { addFile: vi.fn() } as any;

    // Each push rejects (closed panel), but the pipelines must complete and
    // return exactly what the handlers produced.
    await expect(
      processImages(
        ["https://fixture.test/a.png"],
        storage,
        TAB_URL,
        rejectingSend,
      ),
    ).resolves.toEqual(imageMap);
    await expect(
      processAssets(
        {
          css: ["https://fixture.test/a.css"],
          js: ["https://fixture.test/a.js"],
        },
        storage,
        TAB_URL,
        rejectingSend,
      ),
    ).resolves.toEqual(
      new Map([
        ["https://fixture.test/a.css", "styles/a.css"],
        ["https://fixture.test/a.js", "scripts/a.js"],
      ]),
    );
    await expect(
      processDocuments(
        ["https://fixture.test/a.pdf"],
        storage,
        TAB_URL,
        rejectingSend,
      ),
    ).resolves.toEqual(
      new Map([["https://fixture.test/a.pdf", "documents/a.pdf"]]),
    );

    await flushUnhandledRejections();
    expect(unhandled.reasons).toEqual([]);
    expect(unhandled.messages).toEqual([]);
    // Every category still attempted its downloading/downloaded push pair.
    expect(rejectedPushes.map((m) => (m as { key: string }).key)).toEqual([
      "status.downloadingImages",
      "status.imagesDownloaded",
      "status.downloadingCss",
      "status.cssDownloaded",
      "status.downloadingJs",
      "status.jsDownloaded",
      "status.downloadingDocuments",
      "status.documentsDownloaded",
    ]);
  });

  it("pinning: successful sends deliver the exact pre-change payloads and the raw send reaches the handlers", async () => {
    const { processImages, processAssets, processDocuments } =
      await realProcessors();
    const send = vi.fn(); // resolves — panel connected
    const storage = { addFile: vi.fn() } as any;

    await processImages(["https://fixture.test/a.png"], storage, TAB_URL, send);
    await processAssets(
      {
        css: ["https://fixture.test/a.css"],
        js: ["https://fixture.test/a.js"],
      },
      storage,
      TAB_URL,
      send,
    );
    await processDocuments(
      ["https://fixture.test/a.pdf"],
      storage,
      TAB_URL,
      send,
    );

    // All eight push sites, in the established order, byte-identical.
    expect(send.mock.calls).toEqual([
      [{ key: "status.downloadingImages", options: { count: 1 } }],
      [{ key: "status.imagesDownloaded" }],
      [{ key: "status.downloadingCss", options: { count: 1 } }],
      [{ key: "status.cssDownloaded" }],
      [{ key: "status.downloadingJs", options: { count: 1 } }],
      [{ key: "status.jsDownloaded" }],
      [{ key: "status.downloadingDocuments", options: { count: 1 } }],
      [{ key: "status.documentsDownloaded" }],
    ]);
    // The handlers still receive the caller's send callback itself.
    expect(addImageFiles).toHaveBeenCalledWith(
      ["https://fixture.test/a.png"],
      storage,
      TAB_URL,
      send,
      undefined,
      { documentUrl: TAB_URL },
    );
    expect(unhandled.reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Linked page scraper (tasks 6.2 spillover): processQueue's progress, pause,
// stop, failure, and completion pushes. Driven via the REAL scraper module;
// the navigation never completes so the pageTimeout routes the job through
// the failed-scrape push — no scripting or real navigation needed.
// ---------------------------------------------------------------------------

describe("push rejection hygiene — linked page scraper", () => {
  const ORIGINAL_URL = "https://fixture.test/page.html";

  const mockTabsGet = vi.fn();
  const mockTabsUpdate = vi.fn();
  const mockTabsOnUpdated = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
  let savedTabs: unknown;

  beforeEach(() => {
    savedTabs = (globalThis.chrome as { tabs?: unknown }).tabs;
    (globalThis.chrome as { tabs?: unknown }).tabs = {
      get: mockTabsGet,
      update: mockTabsUpdate,
      onUpdated: mockTabsOnUpdated,
    };
    // Scrape start reads the tab; restoreOriginalPage sees the same URL and
    // early-returns. Navigation starts but never completes.
    mockTabsGet.mockResolvedValue({ url: ORIGINAL_URL });
    mockTabsUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    (globalThis.chrome as { tabs?: unknown }).tabs = savedTabs;
  });

  async function makeScraper(
    options?: Partial<LinkedPageScraperOptions>,
  ): Promise<
    InstanceType<
      typeof import("../../src/background/linked-page-scraper").LinkedPageScraper
    >
  > {
    const { LinkedPageScraper } = await vi.importActual<
      typeof import("../../src/background/linked-page-scraper")
    >("../../src/background/linked-page-scraper");
    return new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 50, // real timers — the nav wait rejects quickly
      ...options,
    });
  }

  it("internal phase (progress → failed → complete) with a rejecting send: no unhandled rejection, loop completes", async () => {
    const scraper = await makeScraper();
    await scraper.addToQueue({
      url: "https://fixture.test/linked.html",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    await expect(
      scraper.processQueue(1, { addFile: vi.fn() } as any, rejectingSend),
    ).resolves.toBe("");

    await flushUnhandledRejections();
    expect(unhandled.reasons).toEqual([]);
    expect(unhandled.messages).toEqual([]);
    expect(rejectedPushes).toEqual([
      {
        key: "status.linkedPageProgress",
        options: { current: 1, total: 1, isPaused: false, phase: "internal" },
      },
      "Failed to scrape: https://fixture.test/linked.html",
      {
        key: "status.linkedPagesComplete",
        options: { succeeded: 0, failed: 1 },
      },
    ]);
  });

  it("pinning: successful sends deliver the exact pre-change payloads", async () => {
    const scraper = await makeScraper();
    await scraper.addToQueue({
      url: "https://fixture.test/linked.html",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });
    const send = vi.fn(); // resolves — panel connected

    await expect(
      scraper.processQueue(1, { addFile: vi.fn() } as any, send),
    ).resolves.toBe("");

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      {
        key: "status.linkedPageProgress",
        options: { current: 1, total: 1, isPaused: false, phase: "internal" },
      },
      "Failed to scrape: https://fixture.test/linked.html",
      {
        key: "status.linkedPagesComplete",
        options: { succeeded: 0, failed: 1 },
      },
    ]);
    expect(unhandled.reasons).toEqual([]);
  });

  it("stop before start with a rejecting send: stop notice + completion, no unhandled rejection", async () => {
    const scraper = await makeScraper();
    await scraper.addToQueue({
      url: "https://fixture.test/linked.html",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });
    scraper.stop();

    await expect(
      scraper.processQueue(1, { addFile: vi.fn() } as any, rejectingSend),
    ).resolves.toBe("");

    await flushUnhandledRejections();
    expect(unhandled.reasons).toEqual([]);
    expect(unhandled.messages).toEqual([]);
    expect(rejectedPushes).toEqual([
      "Scraping stopped by user",
      {
        key: "status.linkedPagesComplete",
        options: { succeeded: 0, failed: 0 },
      },
    ]);
  });

  it("pause then stop with a rejecting send: paused notice + completion, no unhandled rejection", async () => {
    const scraper = await makeScraper();
    await scraper.addToQueue({
      url: "https://fixture.test/linked.html",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    scraper.pause();
    try {
      const flow = scraper.processQueue(
        1,
        { addFile: vi.fn() } as any,
        rejectingSend,
      );
      await vi.waitUntil(
        () =>
          rejectedPushes.some(
            (m) => (m as { key?: string }).key === "status.scraperPaused",
          ),
        { timeout: 1000 },
      );
      scraper.stop(); // resolves the paused wait with stop semantics
      await expect(flow).resolves.toBe("");
    } finally {
      scraper.stop(); // clears the paused watchdog even on assertion failure
    }

    await flushUnhandledRejections();
    expect(unhandled.reasons).toEqual([]);
    expect(unhandled.messages).toEqual([]);
    expect(rejectedPushes).toEqual([
      { key: "status.scraperPaused" },
      {
        key: "status.linkedPagesComplete",
        options: { succeeded: 0, failed: 0 },
      },
    ]);
  });

  it("external phase (progress → failed → complete) with a rejecting send: no unhandled rejection", async () => {
    const scraper = await makeScraper({ includeExternal: true });
    await scraper.addToQueue({
      url: "https://other.org/page",
      depth: 1,
      parentUrl: ORIGINAL_URL,
      status: "queued",
    });

    await expect(
      scraper.processQueue(1, { addFile: vi.fn() } as any, rejectingSend),
    ).resolves.toBe("");

    await flushUnhandledRejections();
    expect(unhandled.reasons).toEqual([]);
    expect(unhandled.messages).toEqual([]);
    expect(rejectedPushes).toEqual([
      {
        key: "status.linkedPageProgress",
        options: { current: 1, total: 1, isPaused: false, phase: "external" },
      },
      "Failed to scrape: https://other.org/page",
      {
        key: "status.linkedPagesComplete",
        options: { succeeded: 0, failed: 1 },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// File handlers (tasks 6.2 final spillover): the per-item progress pushes,
// CORS-blocked notices, and summaries inside the file handlers themselves go
// through the same fire-and-forget send. Driven via the REAL handler modules
// (the index mock above only stands in for `../fileHandlers` in the
// download-core/processor suites — importing the inner modules directly
// bypasses it, mirroring the realProcessors/makeScraper convention), over a
// controllable RequestQueue fake: a scoped spy on the singleton's enqueue,
// settled through the request's own callbacks exactly like the real queue.
// ---------------------------------------------------------------------------

type RealImagesHandler =
  typeof import("../../src/background/fileHandlers/images");
type RealCssHandler = typeof import("../../src/background/fileHandlers/css");
type QueueEnqueueRequest = Parameters<typeof requestQueue.enqueue>[0];
/** What the fake queue decides for one enqueued fetch. */
type QueueOutcomeRoute =
  | { ok: true; result: RequestResult }
  | { ok: false; error: unknown };

function realImagesHandler() {
  return vi.importActual<RealImagesHandler>(
    "../../src/background/fileHandlers/images",
  );
}

function realCssHandler() {
  return vi.importActual<RealCssHandler>(
    "../../src/background/fileHandlers/css",
  );
}

/** Minimal RequestResult — the handlers only read `type` and `snapshot`. */
function queueResult(
  url: string,
  snapshotOverrides: Partial<ResponseSnapshot> = {},
): RequestResult {
  const snapshot: ResponseSnapshot = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "image/png" },
    contentType: "image/png",
    type: "basic",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    text: null,
    ...snapshotOverrides,
  };
  return {
    requestId: `req-${url}`,
    url,
    snapshot,
    type: snapshot.type,
    duration: 1,
    size: snapshot.bytes?.byteLength ?? 0,
    fromCache: false,
  } as unknown as RequestResult;
}

/** An opaque (no-cors) result: the body is unreadable (task 2.4). */
function opaqueRoute(url: string): QueueOutcomeRoute {
  return {
    ok: true,
    result: queueResult(url, {
      ok: false,
      status: 0,
      type: "opaque",
      contentType: "",
      headers: {},
      bytes: null,
    }),
  };
}

function networkRoute(): QueueOutcomeRoute {
  return {
    ok: false,
    error: new RequestQueueError("network down", "network"),
  };
}

describe("push rejection hygiene — file handlers", () => {
  const TAB_URL = "https://fixture.test/page.html";

  let enqueueSpy: MockInstance;

  beforeEach(() => {
    // Default: every fetch fails with a categorized queue error.
    enqueueSpy = vi
      .spyOn(requestQueue, "enqueue")
      .mockImplementation(async (request: QueueEnqueueRequest) => {
        request.onError?.(
          new RequestQueueError("queue fake: offline", "network"),
        );
        return `id-${request.url}`;
      });
  });

  afterEach(() => {
    enqueueSpy.mockRestore();
  });

  /** Route enqueued fetches, settling through the request's own callbacks. */
  function routeQueue(route: (url: string) => QueueOutcomeRoute): void {
    enqueueSpy.mockImplementation(async (request: QueueEnqueueRequest) => {
      const outcome = route(request.url);
      if (outcome.ok) request.onComplete?.(outcome.result);
      else request.onError?.(outcome.error as Error);
      return `id-${request.url}`;
    });
  }

  /** ok.png fetches fine, opaque.png is a no-cors response, offline fails. */
  function routeMixedImages(): void {
    routeQueue((url) => {
      if (url === "https://fixture.test/ok.png")
        return { ok: true, result: queueResult(url) };
      if (url === "https://fixture.test/opaque.png") return opaqueRoute(url);
      return networkRoute();
    });
  }

  const MIXED_IMAGES = [
    "https://fixture.test/ok.png",
    "https://fixture.test/opaque.png",
    "https://fixture.test/offline.png",
  ];

  /** All three images.ts push sites, in the established order. */
  const MIXED_IMAGE_PUSHES = [
    { key: "status.imagesProgress", options: { completed: 1, total: 3 } },
    { key: "status.imagesProgress", options: { completed: 2, total: 3 } },
    "Image CORS-blocked (opaque response): https://fixture.test/opaque.png",
    { key: "status.imagesProgress", options: { completed: 3, total: 3 } },
    {
      key: "status.imagesSummary",
      options: {
        succeeded: 1,
        failed: 2,
        skipped: 0,
        failureCategories: { cors: 1, network: 1 },
      },
    },
  ];

  it("addImageFiles with a rejecting send: no unhandled rejection, results flow through", async () => {
    const { addImageFiles } = await realImagesHandler();
    routeMixedImages();
    const storage = { addFile: vi.fn(async () => {}) };

    const filenameMap = await addImageFiles(
      MIXED_IMAGES,
      storage as any,
      TAB_URL,
      rejectingSend,
    );

    // The pipeline is unaffected by the failed pushes: the fetchable image
    // was stored and mapped (raw reference AND absolute URL).
    expect(storage.addFile).toHaveBeenCalledTimes(1);
    expect(filenameMap.get("https://fixture.test/ok.png")).toBe(
      "images/ok.png",
    );
    expect(filenameMap.get(MIXED_IMAGES[0])).toBe("images/ok.png");

    await flushUnhandledRejections();
    expect(unhandled.reasons).toEqual([]);
    expect(unhandled.messages).toEqual([]);
    // All three push sites fired in order: per-item progress, the CORS
    // notice, the summary.
    expect(rejectedPushes).toEqual(MIXED_IMAGE_PUSHES);
  });

  it("pinning: addImageFiles successful sends deliver the exact pre-change payloads", async () => {
    const { addImageFiles } = await realImagesHandler();
    routeMixedImages();
    const send = vi.fn(); // resolves — panel connected

    await addImageFiles(
      MIXED_IMAGES,
      { addFile: vi.fn(async () => {}) } as any,
      TAB_URL,
      send,
    );

    expect(send.mock.calls.map((call) => call[0])).toEqual(MIXED_IMAGE_PUSHES);
    expect(unhandled.reasons).toEqual([]);
  });

  it("addCssFiles (incl. background images) with a rejecting send: no unhandled rejection, results flow through", async () => {
    const { addCssFiles } = await realCssHandler();
    // The failing @import bumps importsFailed — the state-level failure that
    // gates the cssSummary push (background-image failures stay local to
    // downloadBackgroundImages and only feed bgImagesSummary).
    const cssContent =
      '@import url("https://fixture.test/imported.css");\n' +
      'body { background: url("https://fixture.test/bg-opaque.png"); }\n' +
      '.x { background: url("https://fixture.test/bg-offline.png"); }';
    routeQueue((url) => {
      if (url === "https://fixture.test/a.css") {
        return {
          ok: true,
          result: queueResult(url, {
            headers: { "content-type": "text/css" },
            contentType: "text/css",
            bytes: new TextEncoder().encode(cssContent),
          }),
        };
      }
      if (url === "https://fixture.test/bg-opaque.png") return opaqueRoute(url);
      return networkRoute();
    });
    const storage = { addFile: vi.fn(async () => {}) };

    const filenameMap = await addCssFiles(
      ["https://fixture.test/a.css"],
      storage as any,
      TAB_URL,
      rejectingSend,
    );

    // The pipeline is unaffected by the failed pushes: the stylesheet was
    // uploaded and mapped (raw reference AND absolute URL).
    expect(storage.addFile).toHaveBeenCalledWith(
      "styles/a.css",
      expect.any(Blob),
      "text/css",
      "https://fixture.test/a.css",
    );
    expect(filenameMap.get("https://fixture.test/a.css")).toBe("styles/a.css");

    await flushUnhandledRejections();
    expect(unhandled.reasons).toEqual([]);
    expect(unhandled.messages).toEqual([]);
    // All six push sites fired in order: top-level progress, per-bg-image
    // progress + CORS/failure notices, bg summary, css summary.
    expect(rejectedPushes).toEqual([
      { key: "status.cssProgress", options: { completed: 1, total: 1 } },
      { key: "status.bgImagesProgress", options: { completed: 1, total: 2 } },
      "Background image CORS-blocked (opaque response): https://fixture.test/bg-opaque.png",
      { key: "status.bgImagesProgress", options: { completed: 2, total: 2 } },
      "Background image failed (network): https://fixture.test/bg-offline.png",
      {
        key: "status.bgImagesSummary",
        options: { succeeded: 0, failed: 2, skipped: 0 },
      },
      {
        key: "status.cssSummary",
        options: {
          succeeded: 1,
          failed: 0,
          skipped: 0,
          importsSucceeded: undefined,
          importsFailed: 1,
          // Background-image CORS failures stay local to
          // downloadBackgroundImages; only the failed @import is categorized.
          failureCategories: { network: 1 },
        },
      },
    ]);
  });

  it("pinning: addCssFiles successful sends deliver the exact pre-change payloads", async () => {
    const { addCssFiles } = await realCssHandler();
    const cssContent =
      '@import url("https://fixture.test/imported.css");\n' +
      'body { background: url("https://fixture.test/bg-opaque.png"); }\n' +
      '.x { background: url("https://fixture.test/bg-offline.png"); }\n' +
      '.y { background: url("https://fixture.test/bg-ok.png"); }';
    routeQueue((url) => {
      if (url === "https://fixture.test/a.css") {
        return {
          ok: true,
          result: queueResult(url, {
            headers: { "content-type": "text/css" },
            contentType: "text/css",
            bytes: new TextEncoder().encode(cssContent),
          }),
        };
      }
      if (url === "https://fixture.test/bg-ok.png")
        return { ok: true, result: queueResult(url) };
      if (url === "https://fixture.test/bg-opaque.png") return opaqueRoute(url);
      return networkRoute();
    });
    const send = vi.fn(); // resolves — panel connected

    await addCssFiles(
      ["https://fixture.test/a.css"],
      { addFile: vi.fn(async () => {}) } as any,
      TAB_URL,
      send,
    );

    expect(send.mock.calls.map((call) => call[0])).toEqual([
      { key: "status.cssProgress", options: { completed: 1, total: 1 } },
      { key: "status.bgImagesProgress", options: { completed: 1, total: 3 } },
      "Background image CORS-blocked (opaque response): https://fixture.test/bg-opaque.png",
      { key: "status.bgImagesProgress", options: { completed: 2, total: 3 } },
      "Background image failed (network): https://fixture.test/bg-offline.png",
      { key: "status.bgImagesProgress", options: { completed: 3, total: 3 } },
      {
        key: "status.bgImagesSummary",
        options: { succeeded: 1, failed: 2, skipped: 0 },
      },
      {
        key: "status.cssSummary",
        options: {
          succeeded: 1,
          failed: 0,
          skipped: 0,
          importsSucceeded: undefined,
          importsFailed: 1,
          // Background-image CORS failures stay local to
          // downloadBackgroundImages; only the failed @import is categorized.
          failureCategories: { network: 1 },
        },
      },
    ]);
    expect(unhandled.reasons).toEqual([]);
  });
});

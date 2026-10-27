/**
 * (Fix D.1 + D.2) Message-handler tests:
 *
 * - CHECK_DOWNLOAD_LIVE: the liveness query answers truthfully from the
 *   background's live-session tracking (mark/unmark around running
 *   downloads), so a panel that (re)opens mid-download can show
 *   "download in progress" instead of a Resume/Restart card.
 * - DISMISS_INTERRUPTED_DOWNLOAD: scoping — with a session id ONLY that
 *   download's checkpoint is cleared; with no id and no explicit all-flag
 *   NOTHING is cleared (the old behavior wiped every concurrent download's
 *   checkpoint); `{ all: true }` preserves the legacy global wipe.
 *
 * Mock set mirrors message-handler.test.ts; download-state is kept REAL so
 * the liveness tracking is exercised end-to-end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/background/server-client", () => {
  const mocks: Record<string, vi.Mock> = {};
  for (const m of [
    "createSession",
    "uploadHtmlChunk",
    "scrapeComplete",
    "uploadResource",
    "uploadContent",
    "uploadFilenameMap",
    "finalizeSession",
    "getSessionStatus",
    "checkHealth",
    "deleteSession",
  ]) {
    mocks[m] = vi.fn();
  }
  return {
    __esModule: true,
    serverClient: mocks,
    assertSecureBaseUrl: vi.fn(),
    ServerUnavailableError: class ServerUnavailableError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "ServerUnavailableError";
      }
    },
    AuthenticationError: class AuthenticationError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "AuthenticationError";
      }
    },
    AssemblyTimeoutError: class AssemblyTimeoutError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = "AssemblyTimeoutError";
      }
    },
    HttpError: class HttpError extends Error {
      statusCode: number;
      errorCode?: string;
      constructor(message: string, statusCode: number, errorCode?: string) {
        super(message);
        this.name = "HttpError";
        this.statusCode = statusCode;
        this.errorCode = errorCode;
      }
    },
    upgradeInsecureServerUrl: vi.fn((url: string) => url),
  };
});

vi.mock("../../src/background/jobs", () => ({
  scrollDownAndScrape: vi.fn(),
  startDownload: vi.fn(),
}));

vi.mock("../../src/background/download", () => ({
  downloadResourcesWithIncrementalAssembly: vi.fn(),
}));

vi.mock("../../src/background/merge-html", () => ({
  mergeHtmlIncremental: vi.fn(),
}));

vi.mock("../../src/background/scraper-state", () => ({
  pauseScraping: vi.fn(),
  resumeScraping: vi.fn(),
  stopScraping: vi.fn(),
  setCurrentScraper: vi.fn(),
}));

// (D7 / task 1.6) Partial mock: keep resumeServerDownload mocked for the
// messageWorker tests, but load the REAL download-core so the asset-category
// wait (and its new safety bound) is exercised end-to-end below. The
// collaborator mocks mirror download-core-linked-pages-gate.test.ts /
// zero-content-abort.test.ts.
vi.mock("../../src/background/download-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/background/download-core")>();
  return {
    ...actual,
    resumeServerDownload: vi.fn(),
  };
});

vi.mock("../../src/background/cleanupHandlers", () => ({
  cleanupAfterDownload: vi.fn(async () => {}),
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
  // Mirror the real merge (sequential guarded set loops — image entries
  // first and never overwritten) so the merged map reaches uploadFilenameMap.
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
          bytesUploaded: 0,
          totalBytes: 0,
        }),
        waitForAll: async () => {},
        isSessionFull: () => false,
      };
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

vi.mock("../../src/background/download-checkpoint", () => ({
  readCheckpoint: vi.fn(async () => null),
  clearCheckpoint: vi.fn(async () => {}),
  writeCheckpoint: vi.fn(async () => {}),
  updateCheckpointPhase: vi.fn(),
  updateCheckpointResourceUrls: vi.fn(async () => {}),
}));

import { messageWorker } from "../../src/background/message";
import { messageActions } from "../../src/common/message";
import { clearCheckpoint } from "../../src/background/download-checkpoint";
import type { UploadQueue } from "../../src/background/upload-queue";
import {
  getKeepalivePort,
  markSessionLive,
  markSessionNotLive,
  isSessionLive,
  setSessionUploadQueue,
  setSessionPhase,
  setSessionLastError,
} from "../../src/background/download-state";
import {
  downloadResources,
  allSettledWithBound,
} from "../../src/background/download-core";
import { setCurrentScraper } from "../../src/background/scraper-state";
import { getResources } from "../../src/background/resources";
import {
  processImages,
  processAssets,
  processDocuments,
} from "../../src/background/download-processors";
import { serverClient } from "../../src/background/server-client";
import type { FilterOptions } from "../../src/types/filterTypes";

// tests/setup.cjs provides chrome.storage.local; downloadResources also
// creates a keepalive port (chrome.runtime.connect) at flow start — the port
// exposes onMessage and onDisconnect (D2) listeners.
(globalThis.chrome as { runtime?: unknown }).runtime = {
  connect: () => ({
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} },
    postMessage: () => {},
    disconnect: () => {},
  }),
};

const addMessage = vi.fn();

describe("CHECK_DOWNLOAD_LIVE (Fix D.1 liveness)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any liveness left over from a previous test.
    for (const sessionId of ["sess-live", "sess-dead"]) {
      markSessionNotLive(sessionId);
    }
  });

  it("reports live:false for a session that is not running", async () => {
    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-live" },
      addMessage,
    );
    expect(result).toEqual({
      live: false,
      phase: null,
      completed: null,
      total: null,
      tabId: null,
      serverSessionId: "sess-live",
    });
  });

  it("reports live:true once the session was marked live", async () => {
    markSessionLive("sess-live");
    expect(isSessionLive("sess-live")).toBe(true);

    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-live" },
      addMessage,
    );
    expect(result).toEqual({
      live: true,
      phase: null,
      completed: null,
      total: null,
      tabId: null,
      serverSessionId: "sess-live",
    });
  });

  it("reports live:false again after the session was unmarked", async () => {
    markSessionLive("sess-live");
    markSessionNotLive("sess-live");

    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-live" },
      addMessage,
    );
    expect(result).toEqual({
      live: false,
      phase: null,
      completed: null,
      total: null,
      tabId: null,
      serverSessionId: "sess-live",
    });
  });

  it("handles a missing session id without throwing", async () => {
    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      {},
      addMessage,
    );
    expect(result).toEqual({
      live: false,
      phase: null,
      completed: null,
      total: null,
      tabId: null,
      serverSessionId: null,
    });
  });

  it("tracks sessions independently (one live download doesn't leak to another)", () => {
    markSessionLive("sess-a");
    expect(isSessionLive("sess-a")).toBe(true);
    expect(isSessionLive("sess-b")).toBe(false);
    markSessionNotLive("sess-a");
    expect(isSessionLive("sess-a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (Round 9 — Fix B) Extended CHECK_DOWNLOAD_LIVE snapshot: phase, tab,
// upload-queue progress, and the terminal error.
// ---------------------------------------------------------------------------

/** Minimal upload-queue stand-in exposing only getProgress(). */
function fakeQueue(progress: {
  completedCount: number;
  totalCount: number;
}): UploadQueue {
  return {
    getProgress: () => ({
      completedCount: progress.completedCount,
      failedCount: 0,
      totalCount: progress.totalCount,
      bytesUploaded: 0,
      totalBytes: 0,
    }),
  } as unknown as UploadQueue;
}

describe("CHECK_DOWNLOAD_LIVE extended snapshot (Round 9 Fix B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the run's tab, phase, and upload-queue counters while live", async () => {
    markSessionLive("sess-r9", { tabId: 7, phase: "uploading" });
    setSessionUploadQueue(
      "sess-r9",
      fakeQueue({ completedCount: 5, totalCount: 12 }),
    );

    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-r9" },
      addMessage,
    );
    expect(result).toEqual({
      live: true,
      phase: "uploading",
      completed: 5,
      total: 12,
      tabId: 7,
      serverSessionId: "sess-r9",
    });
  });

  it("tracks phase changes from the run (uploading → assembling)", async () => {
    markSessionLive("sess-r9b", { tabId: 3, phase: "uploading" });
    setSessionPhase("sess-r9b", "assembling");

    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-r9b" },
      addMessage,
    );
    expect(result).toMatchObject({ live: true, phase: "assembling" });
  });

  it("reports null counters when no queue is attached", async () => {
    markSessionLive("sess-r9c", { tabId: 3 });

    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-r9c" },
      addMessage,
    );
    expect(result).toMatchObject({
      live: true,
      completed: null,
      total: null,
    });
  });

  it("keeps lastError visible AFTER the session stopped (final poll), and clears it on a new run", async () => {
    markSessionLive("sess-r9d", { tabId: 3 });
    setSessionLastError("sess-r9d", "Assembly timed out");
    markSessionNotLive("sess-r9d");

    const dead = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-r9d" },
      addMessage,
    );
    expect(dead).toMatchObject({
      live: false,
      lastError: "Assembly timed out",
    });

    // A restarted run for the same session clears the previous failure.
    markSessionLive("sess-r9d", { tabId: 3 });
    const restarted = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-r9d" },
      addMessage,
    );
    expect(restarted).toMatchObject({ live: true });
    expect(restarted).not.toHaveProperty("lastError");
  });

  it("omits lastError for a clean run", async () => {
    markSessionLive("sess-r9e");
    markSessionNotLive("sess-r9e");

    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-r9e" },
      addMessage,
    );
    expect(result).toMatchObject({ live: false });
    expect(result).not.toHaveProperty("lastError");
  });
});

describe("DISMISS_INTERRUPTED_DOWNLOAD scoping (Fix D.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears ONLY the targeted session's checkpoint", async () => {
    await messageWorker(
      messageActions.DISMISS_INTERRUPTED_DOWNLOAD,
      { serverSessionId: "sess-A" },
      addMessage,
    );

    expect(clearCheckpoint).toHaveBeenCalledTimes(1);
    expect(clearCheckpoint).toHaveBeenCalledWith("sess-A");
  });

  it("clears NOTHING when no session id is provided (no accidental global wipe)", async () => {
    await messageWorker(
      messageActions.DISMISS_INTERRUPTED_DOWNLOAD,
      {},
      addMessage,
    );

    expect(clearCheckpoint).not.toHaveBeenCalled();
  });

  it("performs the legacy global wipe ONLY via the explicit all-flag", async () => {
    await messageWorker(
      messageActions.DISMISS_INTERRUPTED_DOWNLOAD,
      { all: true },
      addMessage,
    );

    expect(clearCheckpoint).toHaveBeenCalledTimes(1);
    expect(clearCheckpoint).toHaveBeenCalledWith(undefined, { all: true });
  });
});

// ---------------------------------------------------------------------------
// (D7 / task 1.6) The asset-category wait bound. The Promise.allSettled over
// images/assets/documents gates finalization — a category whose promise
// never settles (the residual "paused forever" bug class) used to hold the
// download open indefinitely. The wait now races a workload-sized bound
// (30s per resource, 30-minute cap — the same calculus as the waitForAll
// upload drain): a stalled category is reported failed and finalization
// proceeds, while a healthy (slow but progressing) download is not cut off.
// ---------------------------------------------------------------------------

/** Fake-timer sleep — fires under vi.advanceTimersByTimeAsync. */
const sleepMs = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function serverDownloadOptions(
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

async function runBoundedDownload(
  tabId: number,
  options: FilterOptions,
): Promise<vi.Mock> {
  const sendMessage = vi.fn();
  await downloadResources(
    "<html><body>page</body></html>",
    "https://fixture.test/page.html",
    options,
    sendMessage,
    undefined,
    tabId,
  );
  return sendMessage;
}

const messageKeysOf = (sendMessage: vi.Mock): string[] =>
  sendMessage.mock.calls.map((call) => (call[0] as { key: string }).key);

describe("asset-category wait bound in executeDownloadServerMode (D7 / task 1.6)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockResources({});
    vi.mocked(serverClient.createSession).mockResolvedValue("sess-bound");
    vi.mocked(processImages).mockResolvedValue(new Map());
    vi.mocked(processAssets).mockResolvedValue(new Map());
    vi.mocked(processDocuments).mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it("releases the wait when a category never settles and finalizes with the stall reported", async () => {
    // 2 discovered resources → bound = 2 × 30s = 60s.
    mockResources({
      images: ["https://fixture.test/a.png"],
      css: ["https://fixture.test/style.css"],
    });
    vi.mocked(processImages).mockResolvedValue(
      new Map([["https://fixture.test/a.png", "images/a.png"]]),
    );
    // The stalled category: assets never settle (the stalled-queue class).
    vi.mocked(processAssets).mockImplementation(
      () => new Promise<Map<string, string>>(() => {}),
    );

    vi.useFakeTimers();
    const done = runBoundedDownload(9101, serverDownloadOptions());
    await vi.advanceTimersByTimeAsync(2 * 30_000 + 1_000);
    const sendMessage = await done;

    const keys = messageKeysOf(sendMessage);
    // Finalization proceeded — the download did not hang on the category.
    expect(keys).toContain("status.sendingScrapeComplete");
    expect(keys).toContain("status.complete");
    expect(serverClient.finalizeSession).toHaveBeenCalledTimes(1);
    // The stalled category was reported failed.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Asset processing failed"),
      expect.anything(),
    );
    // Already-settled categories keep their real outcome — the image map
    // still reached the server.
    expect(serverClient.uploadFilenameMap).toHaveBeenCalledWith("sess-bound", {
      "https://fixture.test/a.png": "images/a.png",
    });
  });

  it("treats a bound-expired images category as a hard error (no clean completion)", async () => {
    mockResources({
      images: ["https://fixture.test/a.png"],
      css: ["https://fixture.test/style.css"],
    });
    // Images stall → the bound reports them rejected → hard error.
    vi.mocked(processImages).mockImplementation(
      () => new Promise<Map<string, string>>(() => {}),
    );
    vi.mocked(processAssets).mockResolvedValue(new Map());

    vi.useFakeTimers();
    const done = runBoundedDownload(9102, serverDownloadOptions());
    await vi.advanceTimersByTimeAsync(2 * 30_000 + 1_000);
    const sendMessage = await done;

    const keys = messageKeysOf(sendMessage);
    expect(keys).not.toContain("status.complete");
    expect(keys).not.toContain("status.sendingScrapeComplete");
    expect(serverClient.finalizeSession).not.toHaveBeenCalled();
    // Surface failure — the synthetic bound rejection is not classified as
    // memory/network, so it lands on the generic error path.
    expect(keys).toContain("status.failedWithError");
  });

  it("does not trip the bound for a healthy download with slow-but-progressing categories", async () => {
    // 3 discovered resources → bound = 90s; categories settle at 10/20/30s.
    mockResources({
      images: ["https://fixture.test/a.png"],
      css: ["https://fixture.test/style.css"],
      documents: ["https://fixture.test/doc.pdf"],
    });
    vi.mocked(processImages).mockImplementation(async () => {
      await sleepMs(10_000);
      return new Map([["https://fixture.test/a.png", "images/a.png"]]);
    });
    vi.mocked(processAssets).mockImplementation(async () => {
      await sleepMs(20_000);
      return new Map([["https://fixture.test/style.css", "styles/main.css"]]);
    });
    vi.mocked(processDocuments).mockImplementation(async () => {
      await sleepMs(30_000);
      return new Map([["https://fixture.test/doc.pdf", "documents/doc.pdf"]]);
    });

    vi.useFakeTimers();
    const done = runBoundedDownload(9103, serverDownloadOptions());
    await vi.advanceTimersByTimeAsync(31_000);
    const sendMessage = await done;

    const keys = messageKeysOf(sendMessage);
    expect(keys).toContain("status.complete");
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Asset processing failed"),
      expect.anything(),
    );
    // All three real outcomes merged into ONE uploaded filename map.
    expect(serverClient.uploadFilenameMap).toHaveBeenCalledWith("sess-bound", {
      "https://fixture.test/a.png": "images/a.png",
      "https://fixture.test/style.css": "styles/main.css",
      "https://fixture.test/doc.pdf": "documents/doc.pdf",
    });
  });
});

describe("allSettledWithBound (D7 helper unit)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns every outcome when all categories settle within the bound", async () => {
    const result = await allSettledWithBound(
      [
        Promise.resolve("images"),
        Promise.reject(new Error("assets failed")),
        Promise.resolve("docs"),
      ],
      60_000,
    );
    expect(result[0]).toEqual({ status: "fulfilled", value: "images" });
    expect(result[1].status).toBe("rejected");
    expect((result[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(result[2]).toEqual({ status: "fulfilled", value: "docs" });
  });

  it("releases the wait at the bound, reporting unsettled categories as failed", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    let released = false;
    const done = allSettledWithBound(
      [Promise.resolve("ok"), never],
      5_000,
    ).then((result) => {
      released = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(released).toBe(true);

    const result = await done;
    expect(result[0]).toEqual({ status: "fulfilled", value: "ok" });
    expect(result[1].status).toBe("rejected");
    expect((result[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });

  it("clears the bound timer when the categories settle first (no stray timer)", async () => {
    vi.useFakeTimers();
    expect(vi.getTimerCount()).toBe(0);

    await allSettledWithBound([Promise.resolve("x")], 60_000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not surface a late rejection from an abandoned category", async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    const late = new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });

    const result = await (async () => {
      const wait = allSettledWithBound([Promise.resolve("ok"), late], 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      return await wait;
    })();
    expect(result[1].status).toBe("rejected");

    // The abandoned category rejects AFTER the bound released the wait —
    // the tracker already attached handlers, so this must not become an
    // unhandled rejection crashing the run.
    rejectLate(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(100);
  });
});

// ---------------------------------------------------------------------------
// (D2 / task 2.6) Paused scraper with a disconnected panel reaches
// finalization. The pause wait hangs inside the REAL LinkedPageScraper,
// driven through executeDownloadServerMode's linked-pages gate. When the
// side panel closes, its keepalive port disconnects; the real scraper-state
// hook (wired into download-state via setKeepaliveDisconnectHook at module
// load) must stop the paused scraper so the download settles and the port
// is released — instead of the download hanging forever.
//
// Path under test: the port onDisconnect event (the 60s watchdog variant
// with no disconnect event is covered in
// linked-page-scraper-guards.test.ts). scraper-state is loaded ACTUAL so
// the real wiring runs; the file-level mock's functions delegate to it.
// ---------------------------------------------------------------------------

/** Poll with real timer slices until the condition holds. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!cond()) {
    throw new Error(`Timed out waiting for: ${what}`);
  }
}

describe("paused scraper with disconnected panel reaches finalization (D2 / task 2.6)", () => {
  const TAB_PAUSED = 9201;
  type RealScraperState = typeof import("../../src/background/scraper-state");
  let realScraperState: RealScraperState;

  /**
   * The download's keepalive port, as recorded from chrome.runtime.connect.
   * fireDisconnect simulates the side panel closing (its half of the port
   * dies → the worker-side onDisconnect listeners fire).
   */
  const keepalive: { fireDisconnect: () => void; disconnectCount: number } = {
    fireDisconnect: () => {},
    disconnectCount: 0,
  };

  beforeAll(async () => {
    realScraperState = await vi.importActual<RealScraperState>(
      "../../src/background/scraper-state",
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    keepalive.disconnectCount = 0;
    keepalive.fireDisconnect = () => {};
    (globalThis.chrome as { runtime?: unknown }).runtime = {
      connect: () => {
        const disconnectListeners: Array<() => void> = [];
        keepalive.fireDisconnect = () => {
          for (const fn of disconnectListeners) fn();
        };
        return {
          onMessage: { addListener: () => {} },
          onDisconnect: {
            addListener: (fn: () => void) => {
              disconnectListeners.push(fn);
            },
          },
          postMessage: () => {},
          disconnect: () => {
            keepalive.disconnectCount++;
          },
        };
      },
    };

    // Delegate registration to the REAL scraper-state so its
    // keepalive-disconnect hook can find this download's scraper, then
    // pause via the scraper API — the panel's SCRAPER_PAUSE arriving right
    // after registration. Deterministic: the scraper is already paused when
    // processQueue's first pause check runs, so it parks on the wait before
    // touching any page.
    vi.mocked(setCurrentScraper).mockImplementation((tabId, scraper) => {
      realScraperState.setCurrentScraper(tabId, scraper);
      scraper?.pause();
    });
  });

  afterEach(() => {
    realScraperState.deleteScraper(TAB_PAUSED);
    markSessionNotLive("sess-pause");
    vi.mocked(setCurrentScraper).mockReset();
    // Restore the plain (non-recording) port stub used by the other suites.
    (globalThis.chrome as { runtime?: unknown }).runtime = {
      connect: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      }),
    };
  });

  it("settles the download and releases the keepalive port when the panel's port disconnects mid-pause", async () => {
    mockResources({ links: ["https://fixture.test/page2"] });
    vi.mocked(serverClient.createSession).mockResolvedValue("sess-pause");
    vi.mocked(processImages).mockResolvedValue(new Map());
    vi.mocked(processAssets).mockResolvedValue(new Map());
    vi.mocked(processDocuments).mockResolvedValue(new Map());

    const sendMessage = vi.fn();
    const done = downloadResources(
      "<html><body>page</body></html>",
      "https://fixture.test/page.html",
      serverDownloadOptions({ downloadLinksFullScraping: true }),
      sendMessage,
      undefined,
      TAB_PAUSED,
    );

    // Wait until the scraper is parked on its pause wait…
    await waitFor(
      () =>
        sendMessage.mock.calls.some(
          (call) =>
            (call[0] as { key?: string })?.key === "status.scraperPaused",
        ),
      "the scraper to pause",
    );
    // …then the side panel closes: the keepalive port disconnects.
    keepalive.fireDisconnect();

    // The download promise must SETTLE (here: the success path — stop is a
    // controlled finalization, not a hang).
    await done;

    const keys = sendMessage.mock.calls.map(
      (call) => (call[0] as { key: string }).key,
    );
    expect(keys).toContain("status.scraperPaused");
    // The loop exited and the pipeline finalized.
    expect(keys).toContain("status.linkedPagesComplete");
    expect(keys).toContain("status.complete");
    expect(serverClient.finalizeSession).toHaveBeenCalledTimes(1);
    // The dead port is released — nothing holds the service worker alive.
    expect(getKeepalivePort(TAB_PAUSED)).toBeNull();
  });
});

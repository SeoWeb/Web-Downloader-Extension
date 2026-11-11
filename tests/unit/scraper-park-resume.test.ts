/**
 * Message-level tests for the parked-download path (multipage-download-fixes
 * D2 / tasks 4.4–4.5).
 *
 * Verifies the SCRAPER_RESUME_FROM_PARK and SCRAPER_STOP message handlers:
 * - Resume-from-park re-spawns the scraper from the persisted snapshot
 *   (resumeFromParkedScrape) and consumes the park on success,
 * - a missing/corrupt snapshot falls back cleanly (report + offer Stop),
 *   never crashing the worker,
 * - a definitive resume failure clears the park (Restart offer); a
 *   transient failure keeps it (Retry),
 * - Stop-from-park finalizes the partial via the salvage path
 *   (finalizeParkedDownload) and clears the park,
 * - Stop on a LIVE (paused) download never triggers the parked fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { messageWorker } from "../../src/background/message";
import { messageActions } from "../../src/common/message";
import {
  resumeFromParkedScrape,
  finalizeParkedDownload,
} from "../../src/background/download-core";
import {
  writeScraperSnapshot,
  readScraperSnapshot,
  type LinkedScraperSnapshot,
} from "../../src/background/scraper-snapshot";
import {
  writeCheckpoint,
  readCheckpoint,
} from "../../src/background/download-checkpoint";
import {
  markSessionLive,
  markSessionNotLive,
} from "../../src/background/download-state";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/common/chrome", () => ({
  sendMessage: vi.fn().mockRejectedValue(new Error("no panel")),
}));

vi.mock("../../src/background/jobs", () => ({
  scrollDownAndScrape: vi.fn(),
  startDownload: vi.fn(),
}));

vi.mock("../../src/background/scraper-state", () => ({
  pauseScraping: vi.fn(),
  resumeScraping: vi.fn(),
  stopScraping: vi.fn(),
}));

vi.mock("../../src/background/download-core", () => ({
  resumeServerDownload: vi.fn(),
  resumeFromParkedScrape: vi.fn(),
  finalizeParkedDownload: vi.fn(),
}));

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    createSession: vi.fn(),
    uploadHtmlChunk: vi.fn(),
    scrapeComplete: vi.fn(),
    uploadResource: vi.fn(),
    uploadContent: vi.fn(),
    uploadPageContent: vi.fn(),
    finalizeSession: vi.fn(),
    getSessionStatus: vi.fn(),
    checkHealth: vi.fn(),
    deleteSession: vi.fn(),
  },
  assertSecureBaseUrl: vi.fn(),
  ServerUnavailableError: class extends Error {},
  AuthenticationError: class extends Error {},
}));

// ---------------------------------------------------------------------------

/** In-memory chrome.storage.session (checkpoint + snapshot tests share it). */
let store: Map<string, unknown>;

function installFakeChromeStorage(): void {
  const session = {
    get: async (
      keys?: string | string[] | null,
    ): Promise<Record<string, unknown>> => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store);
      }
      const wanted = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of wanted) {
        if (store.has(k)) out[k] = store.get(k);
      }
      return out;
    },
    set: async (objs: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(objs)) store.set(k, v);
    },
    remove: async (keys: string | string[]): Promise<void> => {
      for (const k of typeof keys === "string" ? [keys] : keys) {
        store.delete(k);
      }
    },
  };
  (globalThis as any).chrome = {
    ...((globalThis as any).chrome ?? {}),
    storage: { ...((globalThis as any).chrome?.storage ?? {}), session },
  };
}

const SESSION_ID = "sess-parked";
const TAB_ID = 7;

function makeSnapshot(
  overrides: Partial<LinkedScraperSnapshot> = {},
): LinkedScraperSnapshot {
  return {
    version: 1,
    serverSessionId: SESSION_ID,
    tabId: TAB_ID,
    tabUrl: "https://example.com/start",
    phase: "internal",
    internalQueue: [
      {
        url: "https://example.com/next",
        depth: 1,
        parentUrl: "https://example.com/start",
      },
    ],
    externalQueue: [],
    visitedUrls: ["https://example.com/done"],
    successCount: 1,
    failCount: 0,
    options: {
      maxPages: 10,
      delayBetweenPages: 0,
      includeExternal: false,
      pageTimeout: 30000,
      downloadImages: true,
      downloadAssets: true,
      downloadDocuments: true,
      extractText: true,
    },
    previousCheckpointPhase: "scraping",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Seed storage with a parked download (snapshot + paused checkpoint). */
async function seedPark(snapshot = makeSnapshot()): Promise<void> {
  await writeScraperSnapshot(snapshot);
  await writeCheckpoint({
    phase: "paused",
    serverSessionId: SESSION_ID,
    tabId: TAB_ID,
    tabUrl: "https://example.com/start",
  });
}

const addMessage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  store = new Map();
  installFakeChromeStorage();
  markSessionNotLive(SESSION_ID);
  vi.mocked(resumeFromParkedScrape).mockResolvedValue(undefined);
  vi.mocked(finalizeParkedDownload).mockResolvedValue(undefined);
});

afterEach(() => {
  delete (globalThis as any).chrome;
  markSessionNotLive(SESSION_ID);
});

// ---------------------------------------------------------------------------
// SCRAPER_RESUME_FROM_PARK
// ---------------------------------------------------------------------------

describe("SCRAPER_RESUME_FROM_PARK (task 4.5)", () => {
  it("re-spawns the scraper from the snapshot and consumes the park on success", async () => {
    await seedPark();

    const result = await messageWorker(
      messageActions.SCRAPER_RESUME_FROM_PARK,
      { serverSessionId: SESSION_ID, tabId: TAB_ID },
      addMessage,
    );

    expect(result).toEqual({ success: true });
    expect(resumeFromParkedScrape).toHaveBeenCalledTimes(1);
    const snapshotArg = vi.mocked(resumeFromParkedScrape).mock.calls[0][0];
    expect(snapshotArg.serverSessionId).toBe(SESSION_ID);
    expect(snapshotArg.tabId).toBe(TAB_ID);
    expect(snapshotArg.internalQueue[0].url).toBe("https://example.com/next");
    expect(snapshotArg.visitedUrls).toEqual(["https://example.com/done"]);
    // The park is consumed
    expect(await readScraperSnapshot(SESSION_ID)).toBeNull();
    expect(await readCheckpoint(SESSION_ID)).toBeNull();
  });

  it("falls back cleanly when the snapshot is missing (report + offer Stop, no crash)", async () => {
    // Checkpoint only — the snapshot is gone
    await writeCheckpoint({
      phase: "paused",
      serverSessionId: SESSION_ID,
      tabId: TAB_ID,
      tabUrl: "https://example.com/start",
    });

    const result = await messageWorker(
      messageActions.SCRAPER_RESUME_FROM_PARK,
      { serverSessionId: SESSION_ID },
      addMessage,
    );

    expect(result).toEqual({
      success: false,
      fallback: true,
      error: "No parked snapshot",
    });
    expect(resumeFromParkedScrape).not.toHaveBeenCalled();
    // The user was told what happened and can still Stop
    const pushed = addMessage.mock.calls.map((c: any[]) => c[0]?.data?.message);
    expect(
      pushed.some(
        (m: any) =>
          typeof m === "string" && m.includes("Stop to deliver the partial"),
      ),
    ).toBe(true);
  });

  it("a CORRUPT snapshot (wrong shape) falls back the same way", async () => {
    store.set(`linkedScraperSnapshot:${SESSION_ID}`, { garbage: true });

    const result = await messageWorker(
      messageActions.SCRAPER_RESUME_FROM_PARK,
      { serverSessionId: SESSION_ID },
      addMessage,
    );

    expect(result).toEqual({
      success: false,
      fallback: true,
      error: "No parked snapshot",
    });
    expect(resumeFromParkedScrape).not.toHaveBeenCalled();
  });

  it("a DEFINITIVE resume failure clears the park (panel offers Restart)", async () => {
    await seedPark();
    vi.mocked(resumeFromParkedScrape).mockRejectedValue(
      new Error("Server session is expired and cannot be resumed"),
    );

    const result = await messageWorker(
      messageActions.SCRAPER_RESUME_FROM_PARK,
      { serverSessionId: SESSION_ID },
      addMessage,
    );

    expect(result.success).toBe(false);
    expect(result.fallback).toBe(true);
    // Park cleared so the expired park never resurfaces
    expect(await readScraperSnapshot(SESSION_ID)).toBeNull();
    expect(await readCheckpoint(SESSION_ID)).toBeNull();
  });

  it("a TRANSIENT resume failure KEEPS the park (Retry possible)", async () => {
    await seedPark();
    vi.mocked(resumeFromParkedScrape).mockRejectedValue(
      new Error("Server unreachable"),
    );

    const result = await messageWorker(
      messageActions.SCRAPER_RESUME_FROM_PARK,
      { serverSessionId: SESSION_ID },
      addMessage,
    );

    expect(result.success).toBe(false);
    expect(result.fallback).toBe(true);
    // Park retained for retry
    expect(await readScraperSnapshot(SESSION_ID)).not.toBeNull();
    expect(await readCheckpoint(SESSION_ID)).not.toBeNull();
  });

  it("a user stop during the park resume (AbortError) clears the park and reports cancellation", async () => {
    await seedPark();
    vi.mocked(resumeFromParkedScrape).mockRejectedValue(
      new DOMException("Download was cancelled", "AbortError"),
    );

    const result = await messageWorker(
      messageActions.SCRAPER_RESUME_FROM_PARK,
      { serverSessionId: SESSION_ID },
      addMessage,
    );

    expect(result).toEqual({ success: true });
    expect(await readScraperSnapshot(SESSION_ID)).toBeNull();
    expect(await readCheckpoint(SESSION_ID)).toBeNull();
    const pushed = addMessage.mock.calls.map((c: any[]) => c[0]?.data?.message);
    expect(pushed.some((m: any) => m?.key === "status.cancelled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stop-from-park via SCRAPER_STOP
// ---------------------------------------------------------------------------

describe("SCRAPER_STOP parked fallback (task 4.5)", () => {
  it("Stop-from-park finalizes the partial and clears the park", async () => {
    await seedPark();

    const result = await messageWorker(
      messageActions.SCRAPER_STOP,
      { tabId: TAB_ID },
      addMessage,
    );

    expect(result).toBe(true);
    expect(finalizeParkedDownload).toHaveBeenCalledTimes(1);
    const params = vi.mocked(finalizeParkedDownload).mock.calls[0][0];
    expect(params.serverSessionId).toBe(SESSION_ID);
    expect(params.tabId).toBe(TAB_ID);
    expect(params.tabUrl).toBe("https://example.com/start");
    // Park consumed — a deliberately stopped download never resurfaces
    expect(await readScraperSnapshot(SESSION_ID)).toBeNull();
    expect(await readCheckpoint(SESSION_ID)).toBeNull();
  });

  it("Stop on a LIVE paused download does NOT trigger the parked fallback", async () => {
    await seedPark();
    markSessionLive(SESSION_ID, { tabId: TAB_ID, phase: "scraping" });

    const result = await messageWorker(
      messageActions.SCRAPER_STOP,
      { tabId: TAB_ID },
      addMessage,
    );

    expect(result).toBe(true);
    expect(finalizeParkedDownload).not.toHaveBeenCalled();
    // The live download's own flow owns its state — park untouched here
    expect(await readScraperSnapshot(SESSION_ID)).not.toBeNull();
  });

  it("Stop with nothing parked does nothing extra", async () => {
    const result = await messageWorker(
      messageActions.SCRAPER_STOP,
      { tabId: TAB_ID },
      addMessage,
    );

    expect(result).toBe(true);
    expect(finalizeParkedDownload).not.toHaveBeenCalled();
  });

  it("a FAILED parked finalize keeps the park so the user can retry the Stop", async () => {
    await seedPark();
    vi.mocked(finalizeParkedDownload).mockRejectedValue(
      new Error("Server unreachable"),
    );

    const result = await messageWorker(
      messageActions.SCRAPER_STOP,
      { tabId: TAB_ID },
      addMessage,
    );

    expect(result.success).toBe(false);
    // Park retained for retry
    expect(await readScraperSnapshot(SESSION_ID)).not.toBeNull();
    expect(await readCheckpoint(SESSION_ID)).not.toBeNull();
  });

  it("the parked fallback is tab-scoped: another tab's Stop does not finalize this park", async () => {
    await seedPark();

    await messageWorker(
      messageActions.SCRAPER_STOP,
      { tabId: 999 },
      addMessage,
    );

    expect(finalizeParkedDownload).not.toHaveBeenCalled();
    expect(await readScraperSnapshot(SESSION_ID)).not.toBeNull();
  });
});

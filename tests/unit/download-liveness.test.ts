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
}));

vi.mock("../../src/background/download-core", () => ({
  resumeServerDownload: vi.fn(),
}));

vi.mock("../../src/background/download-checkpoint", () => ({
  readCheckpoint: vi.fn(async () => null),
  clearCheckpoint: vi.fn(async () => {}),
}));

import { messageWorker } from "../../src/background/message";
import { messageActions } from "../../src/common/message";
import { clearCheckpoint } from "../../src/background/download-checkpoint";
import type { UploadQueue } from "../../src/background/upload-queue";
import {
  markSessionLive,
  markSessionNotLive,
  isSessionLive,
  setSessionUploadQueue,
  setSessionPhase,
  setSessionLastError,
} from "../../src/background/download-state";

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

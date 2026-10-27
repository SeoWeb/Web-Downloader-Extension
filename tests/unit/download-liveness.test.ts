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
import {
  markSessionLive,
  markSessionNotLive,
  isSessionLive,
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
    expect(result).toEqual({ live: false });
  });

  it("reports live:true once the session was marked live", async () => {
    markSessionLive("sess-live");
    expect(isSessionLive("sess-live")).toBe(true);

    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-live" },
      addMessage,
    );
    expect(result).toEqual({ live: true });
  });

  it("reports live:false again after the session was unmarked", async () => {
    markSessionLive("sess-live");
    markSessionNotLive("sess-live");

    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      { sessionId: "sess-live" },
      addMessage,
    );
    expect(result).toEqual({ live: false });
  });

  it("handles a missing session id without throwing", async () => {
    const result = await messageWorker(
      messageActions.CHECK_DOWNLOAD_LIVE,
      {},
      addMessage,
    );
    expect(result).toEqual({ live: false });
  });

  it("tracks sessions independently (one live download doesn't leak to another)", () => {
    markSessionLive("sess-a");
    expect(isSessionLive("sess-a")).toBe(true);
    expect(isSessionLive("sess-b")).toBe(false);
    markSessionNotLive("sess-a");
    expect(isSessionLive("sess-a")).toBe(false);
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

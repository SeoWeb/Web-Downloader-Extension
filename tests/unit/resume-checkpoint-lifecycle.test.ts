/**
 * Tests for the RESUME_SERVER_DOWNLOAD checkpoint lifecycle (D10 / task 4.6).
 *
 * The old flow cleared the checkpoint BEFORE attempting the resume, so a
 * transient failure (server unreachable) destroyed all recovery state. The
 * new flow:
 * - reads the checkpoint,
 * - runs resumeServerDownload,
 * - clears ONLY on success or definitive failure (expired/invalid session),
 * - keeps the checkpoint on transient failure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockResumeServerDownload = vi.fn();
vi.mock("../../src/background/download-core", () => ({
  resumeServerDownload: (...args: any[]) => mockResumeServerDownload(...args),
}));

const mockReadCheckpoint = vi.fn();
const mockClearCheckpoint = vi.fn();
vi.mock("../../src/background/download-checkpoint", () => ({
  readCheckpoint: (...args: any[]) => mockReadCheckpoint(...args),
  clearCheckpoint: (...args: any[]) => mockClearCheckpoint(...args),
  writeCheckpoint: vi.fn(),
  updateCheckpointPhase: vi.fn(),
  updateCheckpointResourceUrls: vi.fn(),
}));

vi.mock("../../src/background/jobs", () => ({
  scrollDownAndScrape: vi.fn(),
  startDownload: vi.fn(),
}));

vi.mock("../../src/background/download", () => ({
  downloadResources: vi.fn(),
  setTabDownloadActive: vi.fn(),
  setTabDownloadComplete: vi.fn(),
  isAnyDownloadInProgress: vi.fn().mockReturnValue(false),
  isTabDownloadInProgress: vi.fn().mockReturnValue(false),
}));

vi.mock("../../src/background/scraper-state", () => ({
  pauseScraping: vi.fn(),
  resumeScraping: vi.fn(),
  stopScraping: vi.fn(),
  setCurrentScraper: vi.fn(),
  deleteScraper: vi.fn(),
}));

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    createSession: vi.fn(),
    uploadHtmlChunk: vi.fn(),
    scrapeComplete: vi.fn(),
    uploadResource: vi.fn(),
    uploadContent: vi.fn(),
    finalizeSession: vi.fn(),
    getSessionStatus: vi.fn(),
    checkHealth: vi.fn(),
  },
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
}));

// ---------------------------------------------------------------------------

import {
  messageWorker,
  isDefinitiveResumeFailure,
} from "../../src/background/message";
import { messageActions } from "../../src/common/message";
import {
  ServerUnavailableError,
  AuthenticationError,
} from "../../src/background/server-client";

const addMessage = vi.fn();

const STORED_CHECKPOINT = {
  downloadInterrupted: true,
  serverSessionId: "sess-42",
  tabUrl: "https://example.com/page",
  tabId: 1,
  phase: "scraping",
  timestamp: 12345,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockReadCheckpoint.mockResolvedValue({ ...STORED_CHECKPOINT });
  mockClearCheckpoint.mockResolvedValue(undefined);
  mockResumeServerDownload.mockResolvedValue(undefined);
});

describe("RESUME_SERVER_DOWNLOAD checkpoint lifecycle (task 4.6)", () => {
  it("clears the checkpoint on successful resume", async () => {
    const result = await messageWorker(
      messageActions.RESUME_SERVER_DOWNLOAD,
      {},
      addMessage,
    );

    expect(mockReadCheckpoint).toHaveBeenCalled();
    expect(mockResumeServerDownload).toHaveBeenCalledWith(
      expect.objectContaining({ serverSessionId: "sess-42" }),
      expect.any(Function),
    );
    expect(mockClearCheckpoint).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  it("keeps the checkpoint on transient failure (server unreachable)", async () => {
    mockResumeServerDownload.mockRejectedValue(
      new ServerUnavailableError("Server is unreachable"),
    );

    const result = await messageWorker(
      messageActions.RESUME_SERVER_DOWNLOAD,
      {},
      addMessage,
    );

    expect(result).toMatchObject({ success: false, fallback: true });
    // The checkpoint survives so the panel can offer Retry after reopen
    expect(mockClearCheckpoint).not.toHaveBeenCalled();
  });

  it("clears the checkpoint on definitive failure (expired session)", async () => {
    mockResumeServerDownload.mockRejectedValue(
      new Error("Server session is expired and cannot be resumed"),
    );

    const result = await messageWorker(
      messageActions.RESUME_SERVER_DOWNLOAD,
      {},
      addMessage,
    );

    expect(result).toMatchObject({ success: false, fallback: true });
    expect(mockClearCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("clears the checkpoint on definitive failure (failed session)", async () => {
    mockResumeServerDownload.mockRejectedValue(
      new Error("Server session is failed and cannot be resumed"),
    );

    await messageWorker(messageActions.RESUME_SERVER_DOWNLOAD, {}, addMessage);

    expect(mockClearCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("keeps the checkpoint when the failure is a network TypeError", async () => {
    mockResumeServerDownload.mockRejectedValue(new TypeError("fetch failed"));

    await messageWorker(messageActions.RESUME_SERVER_DOWNLOAD, {}, addMessage);

    expect(mockClearCheckpoint).not.toHaveBeenCalled();
  });

  it("does not clear anything when the checkpoint came from the panel payload", async () => {
    mockReadCheckpoint.mockResolvedValue(null);

    const result = await messageWorker(
      messageActions.RESUME_SERVER_DOWNLOAD,
      {
        serverSessionId: "sess-from-panel",
        tabUrl: "https://example.com/page",
        tabId: 2,
      },
      addMessage,
    );

    // Success path — nothing was stored, so nothing to clear
    expect(mockResumeServerDownload).toHaveBeenCalledWith(
      expect.objectContaining({ serverSessionId: "sess-from-panel" }),
      expect.any(Function),
    );
    expect(mockClearCheckpoint).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it("returns a fallback error when no checkpoint exists at all", async () => {
    mockReadCheckpoint.mockResolvedValue(null);

    const result = await messageWorker(
      messageActions.RESUME_SERVER_DOWNLOAD,
      {},
      addMessage,
    );

    expect(result).toMatchObject({
      success: false,
      fallback: true,
      error: "No checkpoint found",
    });
    expect(mockResumeServerDownload).not.toHaveBeenCalled();
  });
});

describe("isDefinitiveResumeFailure", () => {
  it("treats expired/failed sessions as definitive", () => {
    expect(
      isDefinitiveResumeFailure(
        new Error("Server session is expired and cannot be resumed"),
      ),
    ).toBe(true);
    expect(
      isDefinitiveResumeFailure(
        new Error("Server session is failed and cannot be resumed"),
      ),
    ).toBe(true);
  });

  it("treats missing session data as definitive", () => {
    expect(
      isDefinitiveResumeFailure(
        new Error("No resource URLs in checkpoint and server has no resources (session=x, received=0) — full restart required"),
      ),
    ).toBe(true);
    expect(
      isDefinitiveResumeFailure(
        new Error("No server session ID in checkpoint"),
      ),
    ).toBe(true);
  });

  it("treats auth failures as definitive", () => {
    // Same class the message module instanceof-checks (both come from the
    // mocked server-client module).
    expect(
      isDefinitiveResumeFailure(new AuthenticationError("Authentication failed")),
    ).toBe(true);
  });

  it("treats transient errors as NOT definitive", () => {
    expect(
      isDefinitiveResumeFailure(new ServerUnavailableError("Server unreachable")),
    ).toBe(false);
    expect(isDefinitiveResumeFailure(new TypeError("fetch failed"))).toBe(false);
    expect(isDefinitiveResumeFailure(new Error("boom"))).toBe(false);
  });
});

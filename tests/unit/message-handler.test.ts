/**
 * Tests for server-mode message handlers (tasks 13.1–13.4).
 *
 * Verifies that the messageWorker correctly routes server-mode
 * message actions to the appropriate ServerClient methods,
 * handles errors consistently, and manages the active session ID.
 *
 * The serverClient singleton is mocked via vi.mock to isolate
 * message-routing logic from HTTP communication.
 */

import { messageWorker } from "../../src/background/message";
import { messageActions } from "../../src/common/message";
import { serverClient } from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
    // pagepocket-client (loaded transitively via download-core → cloud-binding)
    // imports this at module load
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
  scrollDownAndScrape: vi
    .fn()
    .mockResolvedValue({ height: 1000, html: "<p>test</p>" }),
  startDownload: vi.fn().mockResolvedValue(["file1.zip"]),
}));

vi.mock("../../src/background/download", () => ({
  downloadResourcesWithIncrementalAssembly: vi
    .fn()
    .mockResolvedValue(undefined),
}));

vi.mock("../../src/background/merge-html", () => ({
  mergeHtmlIncremental: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/background/scraper-state", () => ({
  pauseScraping: vi.fn(),
  resumeScraping: vi.fn(),
  stopScraping: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a mock function from the mocked serverClient module. */
function mock(method: string): vi.Mock {
  return (serverClient as any)[method] as vi.Mock;
}

/** No-op addMessage callback */
const addMessage = vi.fn();

/** Reset the active server session between tests.
 *
 * (Signature note) setActiveServerSession takes (tabId, sessionId); the old
 * single-arg call `setActiveServerSession(null)` happened to work at runtime
 * (null tab key, sessionId undefined) but only because test files are not
 * type-checked (tsconfig includes src only). Pass both arguments. */
async function resetActiveSession() {
  const { setActiveServerSession } =
    await import("../../src/background/message");
  setActiveServerSession(null as unknown as number, null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("messageWorker — server-mode message actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 13.1 — SERVER_CREATE_SESSION
  // -----------------------------------------------------------------------
  describe("SERVER_CREATE_SESSION", () => {
    it("creates a server session and returns the session ID", async () => {
      mock("createSession").mockResolvedValue("sess-123");

      const result = await messageWorker(
        messageActions.SERVER_CREATE_SESSION,
        {
          url: "https://example.com",
          options: { singleFile: false },
          setActive: true,
        },
        addMessage,
      );

      expect(mock("createSession")).toHaveBeenCalledWith(
        "https://example.com",
        { singleFile: false },
      );
      expect(result).toEqual({ success: true, sessionId: "sess-123" });
    });

    it("returns error when serverClient.createSession fails", async () => {
      mock("createSession").mockRejectedValue(new Error("Network error"));

      const result = await messageWorker(
        messageActions.SERVER_CREATE_SESSION,
        { url: "https://example.com", setActive: true },
        addMessage,
      );

      expect(result).toEqual({ success: false, error: "Network error" });
    });

    it("defaults setActive to true when not specified", async () => {
      mock("createSession").mockResolvedValue("sess-default");

      const result = await messageWorker(
        messageActions.SERVER_CREATE_SESSION,
        { url: "https://example.com" },
        addMessage,
      );

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe("sess-default");
    });
  });

  // -----------------------------------------------------------------------
  // 13.1 — SERVER_UPLOAD_HTML_CHUNK
  // -----------------------------------------------------------------------
  describe("SERVER_UPLOAD_HTML_CHUNK", () => {
    it("uploads an HTML chunk with the specified session ID", async () => {
      mock("uploadHtmlChunk").mockResolvedValue({ received: true });

      const result = await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        {
          sessionId: "sess-abc",
          html: "<p>chunk content</p>",
          scrollIndex: 3,
          pageType: "main",
          pageUrl: "https://example.com/page",
        },
        addMessage,
      );

      expect(mock("uploadHtmlChunk")).toHaveBeenCalledWith(
        "sess-abc",
        "<p>chunk content</p>",
        3,
        "main",
        "https://example.com/page",
      );
      expect(result).toEqual({ success: true, result: { received: true } });
    });

    it("returns error when no session ID is available", async () => {
      await resetActiveSession();

      const result = await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        { html: "<p>no session</p>", scrollIndex: 0 },
        addMessage,
      );

      expect(result).toEqual({
        success: false,
        error: "No active server session",
      });
      expect(mock("uploadHtmlChunk")).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Streamed-state tracking — explicit scrollIndex uploads must advance the
  // per-tab counter so hasStreamedHtmlChunks() truthfully reports that
  // chunks were streamed. Previously the counter only advanced for callers
  // WITHOUT an explicit index, stayed 0 forever in the sidepanel's flow,
  // and download-core re-uploaded the final HTML as chunk 0 (overwriting
  // the skeleton-initializing chunk server-side).
  // -----------------------------------------------------------------------
  describe("SERVER_UPLOAD_HTML_CHUNK streamed-state tracking", () => {
    /** Unique tab ids so module-level session state never leaks across tests. */
    const TAB_A = 777001;
    const TAB_B = 777002;
    const TAB_C = 777003;

    afterEach(async () => {
      const { deleteServerSessionState } =
        await import("../../src/background/message");
      deleteServerSessionState(TAB_A);
      deleteServerSessionState(TAB_B);
      deleteServerSessionState(TAB_C);
    });

    it("advances the tab counter for explicit scrollIndex uploads", async () => {
      mock("uploadHtmlChunk").mockResolvedValue({ received: true });
      const { hasStreamedHtmlChunks, setActiveServerSession } =
        await import("../../src/background/message");

      setActiveServerSession(TAB_A, "sess-stream");
      // Session registered, but nothing streamed yet.
      expect(hasStreamedHtmlChunks(TAB_A)).toBe(false);

      // The sidepanel streams chunk 0 first — even index 0 must mark the
      // tab as having streamed chunks.
      await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        {
          sessionId: "sess-stream",
          html: "<p>step 0</p>",
          scrollIndex: 0,
          pageType: "main",
          tabId: TAB_A,
        },
        addMessage,
      );
      expect(hasStreamedHtmlChunks(TAB_A)).toBe(true);
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-stream",
        "<p>step 0</p>",
        0,
        "main",
        undefined,
      );

      // A later explicit index keeps the counter monotonic (count of
      // streamed chunks = highest index + 1).
      await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        {
          sessionId: "sess-stream",
          html: "<p>step 2</p>",
          scrollIndex: 2,
          pageType: "main",
          tabId: TAB_A,
        },
        addMessage,
      );

      // The implicit fallback for callers without an explicit index then
      // continues AFTER the streamed chunks (index 3, not 0) — this is the
      // observable assertion of the counter's value.
      await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        { html: "<p>implicit</p>", tabId: TAB_A },
        addMessage,
      );
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-stream",
        "<p>implicit</p>",
        3,
        undefined,
        undefined,
      );
    });

    it("does not advance the counter when the upload fails", async () => {
      mock("uploadHtmlChunk").mockRejectedValue(new Error("chunk too large"));
      const { hasStreamedHtmlChunks, setActiveServerSession } =
        await import("../../src/background/message");

      setActiveServerSession(TAB_B, "sess-fail");

      const result = await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        {
          sessionId: "sess-fail",
          html: "<p>step 0</p>",
          scrollIndex: 0,
          pageType: "main",
          tabId: TAB_B,
        },
        addMessage,
      );

      expect(result).toEqual({ success: false, error: "chunk too large" });
      // A failed chunk never reached the server — hasStreamedHtmlChunks
      // must not claim coverage, or download-core would skip the
      // skeleton-initializing chunk-0 upload.
      expect(hasStreamedHtmlChunks(TAB_B)).toBe(false);

      // And the implicit fallback still assigns index 0 (nothing streamed).
      mock("uploadHtmlChunk").mockResolvedValue({ received: true });
      await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        { html: "<p>implicit</p>", tabId: TAB_B },
        addMessage,
      );
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-fail",
        "<p>implicit</p>",
        0,
        undefined,
        undefined,
      );
    });

    it("keeps advancing the counter for implicit-index callers", async () => {
      mock("uploadHtmlChunk").mockResolvedValue({ received: true });
      const { hasStreamedHtmlChunks, setActiveServerSession } =
        await import("../../src/background/message");

      setActiveServerSession(TAB_C, "sess-implicit");

      // Legacy behavior: no explicit scrollIndex → the fallback assigns and
      // increments the counter itself.
      await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        { html: "<p>chunk</p>", tabId: TAB_C },
        addMessage,
      );
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-implicit",
        "<p>chunk</p>",
        0,
        undefined,
        undefined,
      );
      expect(hasStreamedHtmlChunks(TAB_C)).toBe(true);

      await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        { html: "<p>chunk 2</p>", tabId: TAB_C },
        addMessage,
      );
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-implicit",
        "<p>chunk 2</p>",
        1,
        undefined,
        undefined,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 13.1 — SERVER_SCRAPE_COMPLETE
  // -----------------------------------------------------------------------
  describe("SERVER_SCRAPE_COMPLETE", () => {
    it("sends scrape-complete with resource count", async () => {
      mock("scrapeComplete").mockResolvedValue({ status: "uploading" });

      const result = await messageWorker(
        messageActions.SERVER_SCRAPE_COMPLETE,
        { sessionId: "sess-sc", resourceCount: 42 },
        addMessage,
      );

      expect(mock("scrapeComplete")).toHaveBeenCalledWith(
        "sess-sc",
        42,
        undefined,
      );
      expect(result).toEqual({
        success: true,
        result: { status: "uploading" },
      });
    });

    it("defaults resourceCount to 0 when not provided", async () => {
      mock("scrapeComplete").mockResolvedValue({ status: "uploading" });

      await messageWorker(
        messageActions.SERVER_SCRAPE_COMPLETE,
        { sessionId: "sess-sc2" },
        addMessage,
      );

      expect(mock("scrapeComplete")).toHaveBeenCalledWith(
        "sess-sc2",
        0,
        undefined,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 13.1 — SERVER_UPLOAD_RESOURCE
  // -----------------------------------------------------------------------
  describe("SERVER_UPLOAD_RESOURCE", () => {
    it("uploads a resource with all parameters", async () => {
      mock("uploadResource").mockResolvedValue({ stored: true });

      const blob = new Blob(["data"], { type: "image/png" });
      const result = await messageWorker(
        messageActions.SERVER_UPLOAD_RESOURCE,
        {
          sessionId: "sess-ur",
          path: "images/photo.png",
          blob,
          originalUrl: "https://example.com/photo.png",
          contentType: "image/png",
        },
        addMessage,
      );

      expect(mock("uploadResource")).toHaveBeenCalledWith(
        "sess-ur",
        "images/photo.png",
        blob,
        "https://example.com/photo.png",
        "image/png",
      );
      expect(result).toEqual({ success: true, result: { stored: true } });
    });
  });

  // -----------------------------------------------------------------------
  // 13.1 — SERVER_UPLOAD_CONTENT
  // -----------------------------------------------------------------------
  describe("SERVER_UPLOAD_CONTENT", () => {
    it("uploads text content for content.txt", async () => {
      mock("uploadContent").mockResolvedValue({ stored: true });

      const result = await messageWorker(
        messageActions.SERVER_UPLOAD_CONTENT,
        { sessionId: "sess-uc", text: "Page content here" },
        addMessage,
      );

      expect(mock("uploadContent")).toHaveBeenCalledWith(
        "sess-uc",
        "Page content here",
      );
      expect(result).toEqual({ success: true, result: { stored: true } });
    });
  });

  // -----------------------------------------------------------------------
  // 13.1 — SERVER_FINALIZE_SESSION
  // -----------------------------------------------------------------------
  describe("SERVER_FINALIZE_SESSION", () => {
    it("finalizes the session", async () => {
      mock("finalizeSession").mockResolvedValue({ status: "assembling" });

      const result = await messageWorker(
        messageActions.SERVER_FINALIZE_SESSION,
        { sessionId: "sess-fs" },
        addMessage,
      );

      expect(mock("finalizeSession")).toHaveBeenCalledWith("sess-fs");
      expect(result).toEqual({
        success: true,
        result: { status: "assembling" },
      });
    });

    it("returns error when finalize fails", async () => {
      mock("finalizeSession").mockRejectedValue(new Error("409 Conflict"));

      const result = await messageWorker(
        messageActions.SERVER_FINALIZE_SESSION,
        { sessionId: "sess-fs-err" },
        addMessage,
      );

      expect(result).toEqual({ success: false, error: "409 Conflict" });
    });
  });

  // -----------------------------------------------------------------------
  // 13.1 — SERVER_SESSION_STATUS
  // -----------------------------------------------------------------------
  describe("SERVER_SESSION_STATUS", () => {
    it("retrieves session status", async () => {
      const statusResponse = {
        id: "sess-ss",
        status: "assembling",
        assembly_phase: "merging",
        assembly_progress_pct: 60,
      };
      mock("getSessionStatus").mockResolvedValue(statusResponse);

      const result = await messageWorker(
        messageActions.SERVER_SESSION_STATUS,
        { sessionId: "sess-ss" },
        addMessage,
      );

      expect(mock("getSessionStatus")).toHaveBeenCalledWith("sess-ss");
      expect(result).toEqual({ success: true, result: statusResponse });
    });
  });

  // -----------------------------------------------------------------------
  // SERVER_DELETE_SESSION (close-cloud-lifecycle-gaps D2 / task 3.4) —
  // the panel delete flow threads the opt-in deleteCloud flag through.
  // -----------------------------------------------------------------------
  describe("SERVER_DELETE_SESSION", () => {
    it("deletes the session without the cloud option by default", async () => {
      mock("deleteSession").mockResolvedValue(undefined);

      const result = await messageWorker(
        messageActions.SERVER_DELETE_SESSION,
        { sessionId: "sess-del", tabId: 424242 },
        addMessage,
      );

      expect(mock("deleteSession")).toHaveBeenCalledWith("sess-del", {
        deleteCloud: false,
      });
      expect(result).toEqual({ success: true });
    });

    it("threads deleteCloud=true into the delete call (federated delete)", async () => {
      mock("deleteSession").mockResolvedValue(undefined);

      const result = await messageWorker(
        messageActions.SERVER_DELETE_SESSION,
        { sessionId: "sess-del", tabId: 424242, deleteCloud: true },
        addMessage,
      );

      expect(mock("deleteSession")).toHaveBeenCalledWith("sess-del", {
        deleteCloud: true,
      });
      expect(result).toEqual({ success: true });
    });

    it("falls back to the active server session for the tab", async () => {
      mock("deleteSession").mockResolvedValue(undefined);
      const { setActiveServerSession } =
        await import("../../src/background/message");
      setActiveServerSession(424243, "sess-active-del");

      const result = await messageWorker(
        messageActions.SERVER_DELETE_SESSION,
        { tabId: 424243, deleteCloud: true },
        addMessage,
      );

      expect(mock("deleteSession")).toHaveBeenCalledWith("sess-active-del", {
        deleteCloud: true,
      });
      expect(result).toEqual({ success: true });
    });

    it("clears the tab's active session after a successful delete", async () => {
      mock("deleteSession").mockResolvedValue(undefined);
      const { setActiveServerSession, getActiveServerSessionId } =
        await import("../../src/background/message");
      setActiveServerSession(424244, "sess-clear-del");

      const result = await messageWorker(
        messageActions.SERVER_DELETE_SESSION,
        { sessionId: "sess-clear-del", tabId: 424244 },
        addMessage,
      );

      expect(mock("deleteSession")).toHaveBeenCalledWith("sess-clear-del", {
        deleteCloud: false,
      });
      expect(result).toEqual({ success: true });
      expect(getActiveServerSessionId(424244)).toBeNull();
    });

    it("returns error when no session is available", async () => {
      const result = await messageWorker(
        messageActions.SERVER_DELETE_SESSION,
        { tabId: 999999 },
        addMessage,
      );

      expect(mock("deleteSession")).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: "No active server session",
      });
    });

    it("returns error when the delete fails", async () => {
      mock("deleteSession").mockRejectedValue(new Error("Network error"));

      const result = await messageWorker(
        messageActions.SERVER_DELETE_SESSION,
        { sessionId: "sess-del", tabId: 424242 },
        addMessage,
      );

      expect(result).toEqual({ success: false, error: "Network error" });
    });
  });

  // -----------------------------------------------------------------------
  // 13.1 — SERVER_HEALTH_CHECK
  // -----------------------------------------------------------------------
  describe("SERVER_HEALTH_CHECK", () => {
    it("checks server health", async () => {
      mock("checkHealth").mockResolvedValue({ status: "ok", version: "1.0.0" });

      const result = await messageWorker(
        messageActions.SERVER_HEALTH_CHECK,
        {},
        addMessage,
      );

      expect(mock("checkHealth")).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        result: { status: "ok", version: "1.0.0" },
      });
    });

    it("returns error when health check fails", async () => {
      mock("checkHealth").mockRejectedValue(new Error("Connection refused"));

      const result = await messageWorker(
        messageActions.SERVER_HEALTH_CHECK,
        {},
        addMessage,
      );

      expect(result).toEqual({ success: false, error: "Connection refused" });
    });
  });

  // 13.4 — Error handling consistency
  // -----------------------------------------------------------------------
  describe("error handling consistency", () => {
    it("all server-mode handlers return {success, error} on failure", async () => {
      const errorMsg = "Server error";

      // Set all mocks to reject
      mock("createSession").mockRejectedValue(new Error(errorMsg));
      mock("uploadHtmlChunk").mockRejectedValue(new Error(errorMsg));
      mock("scrapeComplete").mockRejectedValue(new Error(errorMsg));
      mock("uploadResource").mockRejectedValue(new Error(errorMsg));
      mock("uploadContent").mockRejectedValue(new Error(errorMsg));
      mock("finalizeSession").mockRejectedValue(new Error(errorMsg));
      mock("getSessionStatus").mockRejectedValue(new Error(errorMsg));
      mock("checkHealth").mockRejectedValue(new Error(errorMsg));

      const actions: Array<[string, Record<string, unknown>]> = [
        [
          messageActions.SERVER_CREATE_SESSION,
          { url: "https://example.com", setActive: true },
        ],
        [
          messageActions.SERVER_UPLOAD_HTML_CHUNK,
          { sessionId: "s1", html: "", scrollIndex: 0 },
        ],
        [
          messageActions.SERVER_SCRAPE_COMPLETE,
          { sessionId: "s1", resourceCount: 0 },
        ],
        [
          messageActions.SERVER_UPLOAD_RESOURCE,
          {
            sessionId: "s1",
            path: "x",
            blob: null,
            originalUrl: "",
            contentType: "",
          },
        ],
        [messageActions.SERVER_UPLOAD_CONTENT, { sessionId: "s1", text: "" }],
        [messageActions.SERVER_FINALIZE_SESSION, { sessionId: "s1" }],
        [messageActions.SERVER_SESSION_STATUS, { sessionId: "s1" }],
        [messageActions.SERVER_HEALTH_CHECK, {}],
      ];

      for (const [action, data] of actions) {
        const result = await messageWorker(action as any, data, addMessage);
        expect(result).toEqual({ success: false, error: errorMsg });
      }
    });
  });

  // -----------------------------------------------------------------------
  // Active session ID fallback
  // -----------------------------------------------------------------------
  describe("active session ID fallback", () => {
    it("SERVER_UPLOAD_HTML_CHUNK falls back to activeServerSessionId", async () => {
      mock("uploadHtmlChunk").mockResolvedValue({ received: true });

      // Create a session first so activeServerSessionId is set
      mock("createSession").mockResolvedValue("sess-active");
      await messageWorker(
        messageActions.SERVER_CREATE_SESSION,
        { url: "https://example.com", setActive: true, tabId: 1 },
        addMessage,
      );

      // Now upload without specifying sessionId — should use active
      const result = await messageWorker(
        messageActions.SERVER_UPLOAD_HTML_CHUNK,
        { html: "<p>chunk</p>", scrollIndex: 0, tabId: 1 },
        addMessage,
      );

      expect(mock("uploadHtmlChunk")).toHaveBeenCalledWith(
        "sess-active",
        "<p>chunk</p>",
        expect.any(Number),
        undefined,
        undefined,
      );
      expect(result.success).toBe(true);

      // Clean up
      await resetActiveSession();
    });
  });

  // -----------------------------------------------------------------------
  // (D3 / tasks 3.1–3.3) SCROLL_AND_EXTRACT_DIFF — the chunk counter may
  // only advance AFTER uploadHtmlChunk resolves successfully. The old
  // `sessionState.scrollIndex++` argument evaluated (incremented) BEFORE
  // the await resolved, so a failed upload still counted as streamed,
  // hasStreamedHtmlChunks() went true, and download-core skipped the
  // chunk-0 "main" initialization upload — finalizing a session with no
  // main-page HTML.
  // -----------------------------------------------------------------------
  describe("SCROLL_AND_EXTRACT_DIFF success-only chunk counter", () => {
    /** Unique tab ids so module-level session state never leaks across tests. */
    const TAB_DIFF_FAIL = 777101;
    const TAB_DIFF_RETRY = 777102;
    const TAB_DIFF_OK = 777103;

    afterEach(async () => {
      const { deleteServerSessionState } =
        await import("../../src/background/message");
      deleteServerSessionState(TAB_DIFF_FAIL);
      deleteServerSessionState(TAB_DIFF_RETRY);
      deleteServerSessionState(TAB_DIFF_OK);
    });

    it("failed first chunk leaves the counter at 0 (task 3.2)", async () => {
      // Client retries exhausted → uploadHtmlChunk rejects.
      mock("uploadHtmlChunk").mockRejectedValue(
        new Error("upload failed: retries exhausted"),
      );
      const { setActiveServerSession, hasStreamedHtmlChunks } =
        await import("../../src/background/message");

      setActiveServerSession(TAB_DIFF_FAIL, "sess-diff-fail");

      const result = await messageWorker(
        messageActions.SCROLL_AND_EXTRACT_DIFF,
        {
          tabId: TAB_DIFF_FAIL,
          htmlChunk: "<p>scroll step 0</p>",
          assemblyJobId: "aj-diff-1",
        },
        addMessage,
      );

      expect(result).toEqual({
        success: false,
        error: "upload failed: retries exhausted",
      });
      // The upload was attempted with the CURRENT index — not a
      // pre-incremented one.
      expect(mock("uploadHtmlChunk")).toHaveBeenCalledTimes(1);
      expect(mock("uploadHtmlChunk")).toHaveBeenCalledWith(
        "sess-diff-fail",
        "<p>scroll step 0</p>",
        0,
        "main",
        undefined,
      );
      // The counter did NOT move: a failed chunk never reached the server.
      expect(hasStreamedHtmlChunks(TAB_DIFF_FAIL)).toBe(false);
    });

    it("a re-requested failed chunk retries at the SAME index, then advances on success", async () => {
      mock("uploadHtmlChunk")
        .mockRejectedValueOnce(new Error("transient network error"))
        .mockResolvedValueOnce({ received: true });
      const { setActiveServerSession, hasStreamedHtmlChunks } =
        await import("../../src/background/message");

      setActiveServerSession(TAB_DIFF_RETRY, "sess-diff-retry");

      // First attempt (index 0) fails …
      const failed = await messageWorker(
        messageActions.SCROLL_AND_EXTRACT_DIFF,
        { tabId: TAB_DIFF_RETRY, htmlChunk: "<p>step 0</p>" },
        addMessage,
      );
      expect(failed.success).toBe(false);
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-diff-retry",
        "<p>step 0</p>",
        0,
        "main",
        undefined,
      );
      expect(hasStreamedHtmlChunks(TAB_DIFF_RETRY)).toBe(false);

      // … the sidepanel re-requests the same chunk — still index 0.
      const retried = await messageWorker(
        messageActions.SCROLL_AND_EXTRACT_DIFF,
        { tabId: TAB_DIFF_RETRY, htmlChunk: "<p>step 0</p>" },
        addMessage,
      );
      expect(retried.success).toBe(true);
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-diff-retry",
        "<p>step 0</p>",
        0,
        "main",
        undefined,
      );
      // Now (and only now) the session counts as having streamed chunks.
      expect(hasStreamedHtmlChunks(TAB_DIFF_RETRY)).toBe(true);
    });

    it("successful chunks advance the counter to the next index (task 3.3)", async () => {
      mock("uploadHtmlChunk").mockResolvedValue({ received: true });
      const { setActiveServerSession, hasStreamedHtmlChunks } =
        await import("../../src/background/message");

      setActiveServerSession(TAB_DIFF_OK, "sess-diff-ok");
      expect(hasStreamedHtmlChunks(TAB_DIFF_OK)).toBe(false);

      await messageWorker(
        messageActions.SCROLL_AND_EXTRACT_DIFF,
        { tabId: TAB_DIFF_OK, htmlChunk: "<p>step 0</p>" },
        addMessage,
      );
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-diff-ok",
        "<p>step 0</p>",
        0,
        "main",
        undefined,
      );
      expect(hasStreamedHtmlChunks(TAB_DIFF_OK)).toBe(true);

      // The next scroll step streams at index 1 (server "next index"
      // semantics, monotonic).
      await messageWorker(
        messageActions.SCROLL_AND_EXTRACT_DIFF,
        { tabId: TAB_DIFF_OK, htmlChunk: "<p>step 1</p>" },
        addMessage,
      );
      expect(mock("uploadHtmlChunk")).toHaveBeenLastCalledWith(
        "sess-diff-ok",
        "<p>step 1</p>",
        1,
        "main",
        undefined,
      );
    });

    // (task 3.3) Main-page chunk 0 is uploaded exactly once per session.
    // The skip leg lives in executeDownloadServerMode (download-core.ts):
    // `if (!hasStreamedHtmlChunks(tabId!))` → the initialization upload
    // `uploadHtmlChunk(sessionId, html, 0, "main")` runs ONLY when nothing
    // streamed. Both legs are pinned end-to-end by zero-content-abort.test.ts
    // ("proceeds normally when the download has content" — non-streamed run
    // uploads the skeleton chunk — and "does not re-upload the HTML chunk
    // for streamed sessions"). This file pins the truth-source the skip
    // reads: hasStreamedHtmlChunks() flips true only after a SUCCESSFUL
    // stream (asserted above), and a failed stream leaves it false, so the
    // initialization upload runs and the archive always contains the main
    // page — exactly once, either streamed at index 0 or initialized.
    it("main-page chunk 0: hasStreamedHtmlChunks gates the download-core skip", async () => {
      mock("uploadHtmlChunk").mockRejectedValue(
        new Error("permanently failing endpoint"),
      );
      const { setActiveServerSession, hasStreamedHtmlChunks } =
        await import("../../src/background/message");

      setActiveServerSession(TAB_DIFF_FAIL, "sess-diff-fail");

      // Every stream attempt fails — the counter stays at 0.
      await messageWorker(
        messageActions.SCROLL_AND_EXTRACT_DIFF,
        { tabId: TAB_DIFF_FAIL, htmlChunk: "<p>step 0</p>" },
        addMessage,
      );
      await messageWorker(
        messageActions.SCROLL_AND_EXTRACT_DIFF,
        { tabId: TAB_DIFF_FAIL, htmlChunk: "<p>step 1</p>" },
        addMessage,
      );

      expect(mock("uploadHtmlChunk")).toHaveBeenCalledTimes(2);
      // Both attempts evaluated at index 0 — no phantom advance.
      expect(mock("uploadHtmlChunk")).toHaveBeenNthCalledWith(
        1,
        "sess-diff-fail",
        "<p>step 0</p>",
        0,
        "main",
        undefined,
      );
      expect(mock("uploadHtmlChunk")).toHaveBeenNthCalledWith(
        2,
        "sess-diff-fail",
        "<p>step 1</p>",
        0,
        "main",
        undefined,
      );
      // download-core's skip therefore stays OFF and the final HTML goes
      // out as chunk 0 ("main") — the initialization upload.
      expect(hasStreamedHtmlChunks(TAB_DIFF_FAIL)).toBe(false);
    });
  });
});

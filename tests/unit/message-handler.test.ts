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
  scrollDownAndScrape: vi.fn().mockResolvedValue({ height: 1000, html: "<p>test</p>" }),
  startDownload: vi.fn().mockResolvedValue(["file1.zip"]),
}));

vi.mock("../../src/background/download", () => ({
  downloadResourcesWithIncrementalAssembly: vi.fn().mockResolvedValue(undefined),
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

/** Reset the active server session between tests. */
async function resetActiveSession() {
  const { setActiveServerSession } = await import("../../src/background/message");
  setActiveServerSession(null);
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
        { url: "https://example.com", options: { singleFile: false }, setActive: true },
        addMessage,
      );

      expect(mock("createSession")).toHaveBeenCalledWith("https://example.com", { singleFile: false });
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

      expect(result).toEqual({ success: false, error: "No active server session" });
      expect(mock("uploadHtmlChunk")).not.toHaveBeenCalled();
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

      expect(mock("scrapeComplete")).toHaveBeenCalledWith("sess-sc", 42);
      expect(result).toEqual({ success: true, result: { status: "uploading" } });
    });

    it("defaults resourceCount to 0 when not provided", async () => {
      mock("scrapeComplete").mockResolvedValue({ status: "uploading" });

      await messageWorker(
        messageActions.SERVER_SCRAPE_COMPLETE,
        { sessionId: "sess-sc2" },
        addMessage,
      );

      expect(mock("scrapeComplete")).toHaveBeenCalledWith("sess-sc2", 0);
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

      expect(mock("uploadContent")).toHaveBeenCalledWith("sess-uc", "Page content here");
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
      expect(result).toEqual({ success: true, result: { status: "assembling" } });
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
      expect(result).toEqual({ success: true, result: { status: "ok", version: "1.0.0" } });
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
        [messageActions.SERVER_CREATE_SESSION, { url: "https://example.com", setActive: true }],
        [messageActions.SERVER_UPLOAD_HTML_CHUNK, { sessionId: "s1", html: "", scrollIndex: 0 }],
        [messageActions.SERVER_SCRAPE_COMPLETE, { sessionId: "s1", resourceCount: 0 }],
        [messageActions.SERVER_UPLOAD_RESOURCE, { sessionId: "s1", path: "x", blob: null, originalUrl: "", contentType: "" }],
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
});

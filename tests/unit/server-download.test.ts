/**
 * Tests for ServerDownloadHandler (tasks 11.1–11.6).
 *
 * Verifies:
 * - (11.5) Download triggers correctly when server ZIP is ready
 * - (11.6) Local fallback works when user chooses after server failure
 * - Assembly polling with 2s interval and 5-minute timeout
 * - chrome.downloads.download with server URL and custom filename
 * - Error categorization and fallback callbacks
 */

import {
  ServerDownloadHandler,
  ServerDownloadResult,
  AssemblyFailedError,
} from "../../src/background/server-download";
import {
  ServerClient,
  ServerUnavailableError,
  AuthenticationError,
  AssemblyTimeoutError,
  SessionStatusResponse,
} from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock SessionStatusResponse. */
function mockStatus(overrides: Partial<SessionStatusResponse> = {}): SessionStatusResponse {
  return {
    id: "test-session-id",
    status: "assembling",
    url: "https://example.com/page",
    html_chunks: 5,
    resources_discovered: 10,
    resources_received: 10,
    total_size: 1024,
    assembly_phase: "merging",
    assembly_progress_pct: 50,
    download_url: null,
    output_type: null,
    output_size: null,
    error_message: null,
    api_version: "v1",
    ...overrides,
  };
}

/** Create a ServerDownloadHandler with a mock ServerClient. */
function createHandler(): {
  handler: ServerDownloadHandler;
  mockGetSessionStatus: vi.SpiedFunction<ServerClient["getSessionStatus"]>;
} {
  const client = new ServerClient();
  const mockGetSessionStatus = vi.spyOn(client, "getSessionStatus");
  const handler = new ServerDownloadHandler(client);
  return { handler, mockGetSessionStatus };
}

// Mock chrome.downloads.download
let mockChromeDownloadsDownload: vi.Mock;
let mockChromeRuntimeLastError: { message: string } | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0));

  mockChromeDownloadsDownload = vi.fn();
  mockChromeRuntimeLastError = undefined;

  // Extend existing chrome mock with downloads API and runtime
  (globalThis.chrome as any).downloads = {
    download: mockChromeDownloadsDownload,
  };
  (globalThis.chrome as any).runtime = {
    ...(globalThis.chrome as any).runtime,
    get lastError() {
      return mockChromeRuntimeLastError;
    },
    connect: vi.fn().mockReturnValue({
      name: "keepalive",
      onDisconnect: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    }),
  };

  // Default: successful download
  mockChromeDownloadsDownload.mockImplementation(
    (options: any, callback: (id: number) => void) => {
      callback(42);
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 11.1 — ServerDownloadHandler class creation
// ---------------------------------------------------------------------------

describe("ServerDownloadHandler", () => {
  it("can be instantiated with a ServerClient", () => {
    const client = new ServerClient();
    const handler = new ServerDownloadHandler(client);
    expect(handler).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 11.2 — chrome.downloads.download with server URL and custom filename
  // -----------------------------------------------------------------------

  describe("triggerServerDownload", () => {
    it("calls chrome.downloads.download with the server URL and filename", async () => {
      const { handler } = createHandler();

      const result = await handler.triggerServerDownload(
        "http://localhost:8000/api/v1/sessions/test-123/download",
        "example-page-1234567890.zip",
      );

      expect(mockChromeDownloadsDownload).toHaveBeenCalledWith(
        {
          url: "http://localhost:8000/api/v1/sessions/test-123/download",
          filename: "example-page-1234567890.zip",
          saveAs: true,
        },
        expect.any(Function),
      );

      expect(result).toBe(42);
    });

    it("throws if chrome.downloads.download fails", async () => {
      const { handler } = createHandler();

      mockChromeRuntimeLastError = { message: "Download failed" };
      mockChromeDownloadsDownload.mockImplementation(
        (options: any, callback: (id: number) => void) => {
          callback(undefined as any);
        },
      );

      await expect(
        handler.triggerServerDownload(
          "http://localhost:8000/api/v1/sessions/test-123/download",
          "test.zip",
        ),
      ).rejects.toThrow("chrome.downloads.download failed");
    });

    it("logs warning for HTTP non-loopback download URLs", async () => {
      const { handler } = createHandler();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation();

      await handler.triggerServerDownload(
        "http://myserver.example.com/api/v1/sessions/test-123/download",
        "test.zip",
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("http://"),
      );

      warnSpy.mockRestore();
    });

    it("does not warn for HTTPS URLs", async () => {
      const { handler } = createHandler();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation();

      await handler.triggerServerDownload(
        "https://myserver.example.com/api/v1/sessions/test-123/download",
        "test.zip",
      );

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("does not warn for localhost HTTP URLs", async () => {
      const { handler } = createHandler();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation();

      await handler.triggerServerDownload(
        "http://localhost:8000/api/v1/sessions/test-123/download",
        "test.zip",
      );

      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // 11.3 — Assembly polling (adaptive interval, 5min timeout)
  // -----------------------------------------------------------------------

  describe("pollAssemblyStatus", () => {
    it("returns immediately when status is ready", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "ready",
          download_url: "http://localhost:8000/api/v1/sessions/test/download",
          output_type: "zip",
          output_size: 50000,
        }),
      );

      const result = await handler.pollAssemblyStatus("test-session-id");

      expect(result.status).toBe("ready");
      expect(result.download_url).toBe("http://localhost:8000/api/v1/sessions/test/download");
      expect(mockGetSessionStatus).toHaveBeenCalledTimes(1);
    });

    it("polls with adaptive intervals until status is ready", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      let callCount = 0;
      mockGetSessionStatus.mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return mockStatus({ status: "assembling", assembly_progress_pct: callCount * 30 });
        }
        return mockStatus({
          status: "ready",
          download_url: "http://localhost:8000/api/v1/sessions/test/download",
          assembly_progress_pct: 100,
        });
      });

      const statusUpdates: Array<{ status: string; phase: string | null; pct: number | null }> = [];
      const promise = handler.pollAssemblyStatus("test-session-id", (status, phase, pct) => {
        statusUpdates.push({ status, phase, pct });
      });

      // Adaptive intervals: first poll at 1s (elapsed < 6s)
      await vi.advanceTimersByTimeAsync(1000);
      // Second poll at 1s (elapsed ~2s, still < 6s)
      await vi.advanceTimersByTimeAsync(1000);
      // Third poll at 1s (elapsed ~3s, still < 6s)
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;

      expect(result.status).toBe("ready");
      expect(mockGetSessionStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(statusUpdates.length).toBeGreaterThanOrEqual(2);
    });

    it("throws when status becomes failed", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "failed",
          error_message: "Assembly error: missing resource",
        }),
      );

      await expect(
        handler.pollAssemblyStatus("test-session-id"),
      ).rejects.toThrow("Assembly failed: Assembly error: missing resource");
    });

    it("throws AssemblyTimeoutError after 5 minutes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0));

      const client = new ServerClient();
      const mockStatusFn = vi.spyOn(client, 'getSessionStatus');
      mockStatusFn.mockResolvedValue(mockStatus({ status: "assembling" }));
      const handlerTimeout = new ServerDownloadHandler(client);

      // Attach the rejection handler BEFORE starting the poll
      const pollPromise = handlerTimeout.pollAssemblyStatus("test-session-id");
      const rejectionPromise = pollPromise.catch((err) => err);

      // Advance system time to simulate 5+ minutes passing
      // and advance timers to resolve the sleep() calls
      //
      // We do this in large steps: advance time, then advance timers
      // so both Date.now() and setTimeout are synchronized
      for (let i = 0; i < 16; i++) {
        vi.setSystemTime(Date.now() + 20000); // 20 seconds per step
        await vi.advanceTimersByTimeAsync(20000);
      }

      const error = await rejectionPromise;
      expect(error).toBeInstanceOf(AssemblyTimeoutError);

      mockStatusFn.mockRestore();
    }, 10000);

    it("continues polling through transient ServerUnavailableError", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      let callCount = 0;
      mockGetSessionStatus.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new ServerUnavailableError("Network error", undefined, undefined);
        }
        return mockStatus({
          status: "ready",
          download_url: "http://localhost:8000/api/v1/sessions/test/download",
        });
      });

      const promise = handler.pollAssemblyStatus("test-session-id");

      // Advance through the first failed poll
      await vi.advanceTimersByTimeAsync(2000);
      // Advance through the second successful poll
      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;
      expect(result.status).toBe("ready");
    });

    it("can be cancelled via cancelPolling()", async () => {
      const client = new ServerClient();
      const mockStatusFn = vi.spyOn(client, 'getSessionStatus');
      mockStatusFn.mockResolvedValue(mockStatus({ status: "assembling" }));
      const handlerCancel = new ServerDownloadHandler(client);

      // Attach rejection handler BEFORE starting the poll
      const pollPromise = handlerCancel.pollAssemblyStatus("test-session-id");
      const rejectionPromise = pollPromise.catch((err) => err);

      // Advance one poll cycle
      vi.setSystemTime(Date.now() + 2000);
      await vi.advanceTimersByTimeAsync(2000);

      // Cancel
      handlerCancel.cancelPolling();

      // Advance timers to trigger the sleep which will detect abort
      vi.setSystemTime(Date.now() + 2000);
      await vi.advanceTimersByTimeAsync(2000);

      const error = await rejectionPromise;
      expect(error).toBeDefined();
      expect(error.name).toBe("AbortError");

      mockStatusFn.mockRestore();
    });

    it("calls onStatusUpdate with assembly phase and progress", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "assembling",
          assembly_phase: "converting",
          assembly_progress_pct: 75,
        }),
      );

      const updates: Array<{ status: string; phase: string | null; pct: number | null }> = [];
      const promise = handler.pollAssemblyStatus("test-session-id", (status, phase, pct) => {
        updates.push({ status, phase, pct });
      });

      // Let one poll happen
      await vi.advanceTimersByTimeAsync(2000);

      // Now resolve with ready
      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "ready",
          download_url: "http://localhost:8000/api/v1/sessions/test/download",
          assembly_phase: null,
          assembly_progress_pct: null,
        }),
      );

      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;
      expect(result.status).toBe("ready");

      // Check that at least one update with phase and progress was received
      const assemblingUpdate = updates.find((u) => u.phase === "converting");
      expect(assemblingUpdate).toBeDefined();
      expect(assemblingUpdate!.pct).toBe(75);
    });

    it("uses adaptive polling intervals (1s → 2s → 3s → 5s)", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      const pollTimes: number[] = [];

      mockGetSessionStatus.mockImplementation(async () => {
        pollTimes.push(Date.now());
        return mockStatus({ status: "assembling" });
      });

      const pollPromise = handler.pollAssemblyStatus("test-session-id");
      const resultPromise = pollPromise.catch(() => "polling");

      // Advance 80 seconds in 1-second steps (GCD of all intervals)
      // so timers at every tier fire cleanly without desynchronization.
      for (let i = 0; i < 80; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      expect(pollTimes.length).toBeGreaterThan(10);

      // Verify every gap matches the expected interval for its tier.
      // The gap between poll[i-1] and poll[i] was set by getPollInterval(elapsed)
      // where elapsed = pollTimes[i-1] (since startTime = 0).
      function expectedGap(elapsedMs: number): number {
        if (elapsedMs < 6000) return 1000;
        if (elapsedMs < 30000) return 2000;
        if (elapsedMs < 60000) return 3000;
        return 5000;
      }

      // Compute elapsed relative to the first poll (which equals startTime)
      const startTime = pollTimes[0];
      for (let i = 1; i < pollTimes.length; i++) {
        const gap = pollTimes[i] - pollTimes[i - 1];
        const elapsed = pollTimes[i - 1] - startTime;
        expect(gap).toBe(expectedGap(elapsed));
      }
    });
  });

  // -----------------------------------------------------------------------
  // 11.5 — Verify: download triggers correctly when server ZIP is ready
  // -----------------------------------------------------------------------

  describe("waitForDownload", () => {
    it("polls for assembly, then triggers download when ready", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "ready",
          download_url: "http://localhost:8000/api/v1/sessions/test/download",
          output_type: "zip",
        }),
      );

      const result = await handler.waitForDownload(
        "test-session-id",
        "https://example.com/page",
        false, // isSingleFile
      );

      // Verify download was triggered
      expect(mockChromeDownloadsDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "http://localhost:8000/api/v1/sessions/test/download",
          filename: expect.stringMatching(/\.zip$/),
          saveAs: true,
        }),
        expect.any(Function),
      );

      // Verify result
      expect(result.downloadId).toBe(42);
      expect(result.downloadUrl).toBe("http://localhost:8000/api/v1/sessions/test/download");
      expect(result.filename).toMatch(/\.zip$/);
    });

    it("uses .html extension for single-file mode", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "ready",
          download_url: "http://localhost:8000/api/v1/sessions/test/download",
          output_type: "html",
        }),
      );

      const result = await handler.waitForDownload(
        "test-session-id",
        "https://example.com/page",
        true, // isSingleFile
      );

      expect(result.filename).toMatch(/\.html$/);
    });

    it("throws if download_url is missing in ready status", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "ready",
          download_url: null, // No download URL!
        }),
      );

      await expect(
        handler.waitForDownload("test-session-id", "https://example.com/page", false),
      ).rejects.toThrow("no download URL returned");
    });
  });

  // -----------------------------------------------------------------------
  // 11.4 + 11.6 — Local fallback on server failure/timeout
  // -----------------------------------------------------------------------

  describe("downloadWithFallback", () => {
    it("returns result on success without invoking fallback", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "ready",
          download_url: "http://localhost:8000/api/v1/sessions/test/download",
        }),
      );

      const fallbackCb = vi.fn();

      const result = await handler.downloadWithFallback(
        "test-session-id",
        "https://example.com/page",
        false,
        fallbackCb,
      );

      expect(result).not.toBeNull();
      expect(result!.downloadId).toBe(42);
      expect(fallbackCb).not.toHaveBeenCalled();
    });

    it("offers local fallback on AssemblyTimeoutError", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      // Always return assembling to trigger timeout
      mockGetSessionStatus.mockResolvedValue(
        mockStatus({ status: "assembling" }),
      );

      const fallbackCb = vi.fn().mockResolvedValue(true); // User chooses local

      const promise = handler.downloadWithFallback(
        "test-session-id",
        "https://example.com/page",
        false,
        fallbackCb,
      );

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2000);

      const result = await promise;

      // User chose local fallback → result is null
      expect(result).toBeNull();
      expect(fallbackCb).toHaveBeenCalledWith(
        "assembly_timeout",
        expect.stringContaining("taking too long"),
      );
    });

    it("categorizes AuthenticationError as auth_failed", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      // AuthenticationError is NOT caught by the polling loop and will
      // propagate immediately to downloadWithFallback, where it is
      // now explicitly categorized as auth_failed.
      mockGetSessionStatus.mockRejectedValue(
        new AuthenticationError("Auth failed after re-registration"),
      );

      const fallbackCb = vi.fn().mockResolvedValue(true);

      const result = await handler.downloadWithFallback(
        "test-session-id",
        "https://example.com/page",
        false,
        fallbackCb,
      );

      expect(result).toBeNull();
      expect(fallbackCb).toHaveBeenCalledWith(
        "auth_failed",
        expect.stringContaining("Authentication failed"),
      );
    });

    it("offers local fallback on AssemblyFailedError", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "failed",
          error_message: "Missing critical resource",
        }),
      );

      const fallbackCb = vi.fn().mockResolvedValue(true);

      const result = await handler.downloadWithFallback(
        "test-session-id",
        "https://example.com/page",
        false,
        fallbackCb,
      );

      expect(result).toBeNull();
      expect(fallbackCb).toHaveBeenCalledWith(
        "assembly_failed",
        expect.stringContaining("Missing critical resource"),
      );
    });

    it("re-throws error when user declines local fallback", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "failed",
          error_message: "Something went wrong",
        }),
      );

      const fallbackCb = vi.fn().mockResolvedValue(false); // User declines

      await expect(
        handler.downloadWithFallback(
          "test-session-id",
          "https://example.com/page",
          false,
          fallbackCb,
        ),
      ).rejects.toThrow("Assembly failed");

      expect(fallbackCb).toHaveBeenCalled();
    });

    it("categorizes AssemblyFailedError correctly", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      // Simulate an assembly failure
      mockGetSessionStatus.mockResolvedValue(
        mockStatus({
          status: "failed",
          error_message: "Disk write error",
        }),
      );

      const fallbackCb = vi.fn().mockResolvedValue(true);

      const result = await handler.downloadWithFallback(
        "test-session-id",
        "https://example.com/page",
        false,
        fallbackCb,
      );

      expect(result).toBeNull();
      expect(fallbackCb).toHaveBeenCalledWith(
        "assembly_failed",
        expect.stringContaining("Assembly failed"),
      );
    });
    it("categorizes ServerUnavailableError as server_unavailable (not assembly_failed)", async () => {
      const { handler, mockGetSessionStatus } = createHandler();

      // Simulate persistent server unavailability that times out the poll loop.
      // After timeout, the AssemblyTimeoutError will be thrown, but we need
      // to test ServerUnavailableError categorization in downloadWithFallback.
      // Instead, directly test by making pollAssemblyStatus throw ServerUnavailableError.
      const pollSpy = vi.spyOn(handler, 'pollAssemblyStatus');
      pollSpy.mockRejectedValue(
        new ServerUnavailableError("Connection refused", undefined, 503),
      );

      const fallbackCb = vi.fn().mockResolvedValue(true);

      const result = await handler.downloadWithFallback(
        "test-session-id",
        "https://example.com/page",
        false,
        fallbackCb,
      );

      expect(result).toBeNull();
      expect(fallbackCb).toHaveBeenCalledWith(
        "server_unavailable",
        expect.stringContaining("Server is unavailable"),
      );

      pollSpy.mockRestore();
    });
  });
});

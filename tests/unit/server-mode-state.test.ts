/**
 * Unit tests for server-mode UI state transitions (task 15.8).
 *
 * Tests the `applyServerModeMessage` pure function that drives all
 * server-mode phase transitions in the side panel UI.
 */

import {
  ServerModeState,
  initialServerModeState,
  applyServerModeMessage,
} from "../../src/sidepanel/server-mode-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply a sequence of messages and return the final state. */
function applyMessages(
  messages: Array<{ key: string; options?: Record<string, any> }>,
  start: ServerModeState = initialServerModeState,
): ServerModeState {
  return messages.reduce(
    (state, msg) => applyServerModeMessage(state, msg.key, msg.options),
    start,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyServerModeMessage", () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  it("should have null phase in initial state", () => {
    expect(initialServerModeState.phase).toBeNull();
    expect(initialServerModeState.uploadCompleted).toBe(0);
    expect(initialServerModeState.uploadTotal).toBe(0);
    expect(initialServerModeState.assemblyPhase).toBeNull();
    expect(initialServerModeState.assemblyProgressPct).toBeNull();
    expect(initialServerModeState.serverDownloadUrl).toBeNull();
    expect(initialServerModeState.isSingleFile).toBe(false);
    expect(initialServerModeState.serverError).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 15.7 — Scraping phase
  // -----------------------------------------------------------------------

  it("should transition to scraping on status.scraping", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.scraping");
    expect(next.phase).toBe("scraping");
  });

  // -----------------------------------------------------------------------
  // 15.7 — Scraping → Uploading transition
  // -----------------------------------------------------------------------

  it("should transition to uploading on status.sendingScrapeComplete", () => {
    const state = applyServerModeMessage(initialServerModeState, "status.scraping");
    const next = applyServerModeMessage(state, "status.sendingScrapeComplete");
    expect(next.phase).toBe("uploading");
  });

  it("should transition to uploading on status.scrapeComplete", () => {
    const state = applyServerModeMessage(initialServerModeState, "status.scraping");
    const next = applyServerModeMessage(state, "status.scrapeComplete");
    expect(next.phase).toBe("uploading");
  });

  it("should transition to uploading on status.waitingForUploads", () => {
    const state = applyServerModeMessage(initialServerModeState, "status.scraping");
    const next = applyServerModeMessage(state, "status.waitingForUploads");
    expect(next.phase).toBe("uploading");
  });

  // -----------------------------------------------------------------------
  // 15.1 — Upload progress
  // -----------------------------------------------------------------------

  it("should update upload progress and infer uploading phase", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.uploadProgress", {
      completed: 5,
      total: 20,
    });
    expect(next.phase).toBe("uploading");
    expect(next.uploadCompleted).toBe(5);
    expect(next.uploadTotal).toBe(20);
  });

  it("should preserve current phase during upload progress if already set", () => {
    const scraping = applyServerModeMessage(initialServerModeState, "status.scraping");
    const next = applyServerModeMessage(scraping, "status.uploadProgress", {
      completed: 3,
      total: 10,
    });
    // Phase should remain 'scraping' because prev.phase is already set
    expect(next.phase).toBe("scraping");
    expect(next.uploadCompleted).toBe(3);
    expect(next.uploadTotal).toBe(10);
  });

  it("should accumulate upload progress across multiple messages", () => {
    const state1 = applyServerModeMessage(initialServerModeState, "status.uploadProgress", {
      completed: 3,
      total: 10,
    });
    const state2 = applyServerModeMessage(state1, "status.uploadProgress", {
      completed: 7,
      total: 10,
    });
    expect(state2.uploadCompleted).toBe(7);
    expect(state2.uploadTotal).toBe(10);
  });

  // -----------------------------------------------------------------------
  // 15.2 — Assembly status display
  // -----------------------------------------------------------------------

  it("should transition to assembling on status.finalizingServer", () => {
    const uploading = applyServerModeMessage(initialServerModeState, "status.scrapeComplete");
    const next = applyServerModeMessage(uploading, "status.finalizingServer");
    expect(next.phase).toBe("assembling");
  });

  it("should transition to assembling on status.assemblingServer", () => {
    const uploading = applyServerModeMessage(initialServerModeState, "status.scrapeComplete");
    const next = applyServerModeMessage(uploading, "status.assemblingServer");
    expect(next.phase).toBe("assembling");
  });

  it("should update assembly progress with phase and percentage", () => {
    const uploading = applyServerModeMessage(initialServerModeState, "status.scrapeComplete");
    const next = applyServerModeMessage(uploading, "status.assemblyProgress", {
      phase: "merging_html",
      progressPct: 42,
    });
    expect(next.phase).toBe("assembling");
    expect(next.assemblyPhase).toBe("merging_html");
    expect(next.assemblyProgressPct).toBe(42);
  });

  it("should preserve previous assembly values when options are absent", () => {
    const uploading = applyServerModeMessage(initialServerModeState, "status.scrapeComplete");
    const assembling = applyServerModeMessage(uploading, "status.assemblyProgress", {
      phase: "converting",
      progressPct: 60,
    });
    const next = applyServerModeMessage(assembling, "status.assemblyProgress", {});
    expect(next.assemblyPhase).toBe("converting");
    expect(next.assemblyProgressPct).toBe(60);
  });

  // -----------------------------------------------------------------------
  // 15.3 — Download from server (ready state)
  // -----------------------------------------------------------------------

  it("should transition to ready on status.complete with download URL", () => {
    const assembling = applyServerModeMessage(initialServerModeState, "status.assemblingServer");
    const next = applyServerModeMessage(assembling, "status.complete", {
      downloadUrl: "https://server.example.com/api/v1/sessions/abc/download",
      isSingleFile: false,
    });
    expect(next.phase).toBe("ready");
    expect(next.serverDownloadUrl).toBe("https://server.example.com/api/v1/sessions/abc/download");
    expect(next.isSingleFile).toBe(false);
  });

  it("should transition to ready on status.complete with singleFile=true", () => {
    const assembling = applyServerModeMessage(initialServerModeState, "status.assemblingServer");
    const next = applyServerModeMessage(assembling, "status.complete", {
      downloadUrl: "https://server.example.com/api/v1/sessions/abc/download",
      isSingleFile: true,
    });
    expect(next.phase).toBe("ready");
    expect(next.isSingleFile).toBe(true);
  });

  it("should accept download URL from status.complete even without serverDownloadReady", () => {
    const next = applyMessages([
      { key: "status.scraping" },
      { key: "status.scrapeComplete" },
      { key: "status.assemblingServer" },
      {
        key: "status.complete",
        options: {
          downloadUrl: "https://server.example.com/api/v1/sessions/xyz/download",
          isSingleFile: true,
        },
      },
    ]);
    expect(next.phase).toBe("ready");
    expect(next.serverDownloadUrl).toBe("https://server.example.com/api/v1/sessions/xyz/download");
    expect(next.isSingleFile).toBe(true);
  });

  // 15.3 — serverDownloadReady (explicit URL signal)
  it("should update download URL on status.serverDownloadReady without changing phase", () => {
    const assembling = applyServerModeMessage(initialServerModeState, "status.assemblingServer");
    const next = applyServerModeMessage(assembling, "status.serverDownloadReady", {
      downloadUrl: "https://server.example.com/api/v1/sessions/abc/download",
      isSingleFile: false,
    });
    // Phase should remain 'assembling' — serverDownloadReady only sets the URL
    expect(next.phase).toBe("assembling");
    expect(next.serverDownloadUrl).toBe("https://server.example.com/api/v1/sessions/abc/download");
  });

  // -----------------------------------------------------------------------
  // 15.5 — Server error display
  // -----------------------------------------------------------------------

  it("should transition to failed on status.serverError (server_unavailable)", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.serverError", {
      error: "Connection refused",
      canFallback: true,
      reason: "server_unavailable",
    });
    expect(next.phase).toBe("failed");
    expect(next.serverError).toEqual({
      error: "Connection refused",
      canFallback: true,
      reason: "server_unavailable",
    });
  });

  it("should transition to failed on status.serverError (assembly_failed)", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.serverError", {
      error: "Assembly crashed",
      canFallback: true,
      reason: "assembly_failed",
    });
    expect(next.phase).toBe("failed");
    expect(next.serverError?.reason).toBe("assembly_failed");
  });

  it("should transition to failed on status.serverError (auth_failed)", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.serverError", {
      error: "API key rejected",
      canFallback: false,
      reason: "auth_failed",
    });
    expect(next.phase).toBe("failed");
    expect(next.serverError?.canFallback).toBe(false);
  });

  it("should default reason to server_unavailable when missing", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.serverError", {});
    expect(next.phase).toBe("failed");
    expect(next.serverError?.reason).toBe("server_unavailable");
  });

  // -----------------------------------------------------------------------
  // 15.6 — Assembly timeout
  // -----------------------------------------------------------------------

  it("should transition to timeout on status.serverError with assembly_timeout reason", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.serverError", {
      error: "Assembly took too long",
      canFallback: true,
      reason: "assembly_timeout",
    });
    expect(next.phase).toBe("timeout");
    expect(next.serverError?.reason).toBe("assembly_timeout");
    expect(next.serverError?.canFallback).toBe(true);
  });

  it("should transition to timeout on status.serverFallbackOffer with assembly_timeout", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.serverFallbackOffer", {
      errorMessage: "Timeout",
      reason: "assembly_timeout",
    });
    expect(next.phase).toBe("timeout");
    expect(next.serverError?.canFallback).toBe(true);
    expect(next.serverError?.error).toBe("Timeout");
  });

  it("should transition to failed on status.serverFallbackOffer with non-timeout reason", () => {
    const next = applyServerModeMessage(initialServerModeState, "status.serverFallbackOffer", {
      errorMessage: "Server error",
      reason: "server_unavailable",
    });
    expect(next.phase).toBe("failed");
    expect(next.serverError?.canFallback).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 15.8 — Full lifecycle: all states reachable
  // -----------------------------------------------------------------------

  it("should reach all 6 server-mode states in a full download lifecycle", () => {
    // Phase 1: scraping
    const s1 = applyServerModeMessage(initialServerModeState, "status.scraping");
    expect(s1.phase).toBe("scraping");

    // Phase 2: uploading
    const s2 = applyServerModeMessage(s1, "status.scrapeComplete");
    expect(s2.phase).toBe("uploading");

    // Phase 3: assembling
    const s3 = applyServerModeMessage(s2, "status.assemblingServer");
    expect(s3.phase).toBe("assembling");

    // Phase 4: ready
    const s4 = applyServerModeMessage(s3, "status.complete", {
      downloadUrl: "https://server/download",
      isSingleFile: false,
    });
    expect(s4.phase).toBe("ready");
  });

  it("should reach failed state when server is unavailable", () => {
    const s1 = applyServerModeMessage(initialServerModeState, "status.scraping");
    const s2 = applyServerModeMessage(s1, "status.serverError", {
      error: "Connection refused",
      canFallback: true,
      reason: "server_unavailable",
    });
    expect(s2.phase).toBe("failed");
  });

  it("should reach timeout state when assembly times out", () => {
    const s1 = applyMessages([
      { key: "status.scraping" },
      { key: "status.scrapeComplete" },
      { key: "status.assemblingServer" },
    ]);
    const s2 = applyServerModeMessage(s1, "status.serverError", {
      error: "5 minute timeout",
      canFallback: true,
      reason: "assembly_timeout",
    });
    expect(s2.phase).toBe("timeout");
  });

  // -----------------------------------------------------------------------
  // Unknown message
  // -----------------------------------------------------------------------

  it("should return unchanged state for unknown message keys", () => {
    const scraping = applyServerModeMessage(initialServerModeState, "status.scraping");
    const next = applyServerModeMessage(scraping, "status.unknownMessage");
    expect(next).toEqual(scraping);
  });

  it("should return unchanged state for empty message key", () => {
    const next = applyServerModeMessage(initialServerModeState, "");
    expect(next).toEqual(initialServerModeState);
  });
});

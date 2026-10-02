/**
 * Server-mode UI state management (tasks 15.1–15.8).
 *
 * Pure functions for server-mode state transitions driven by
 * background message keys.  Extracted from sidepanel.tsx so the
 * transition logic can be unit-tested without React.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerModeState {
  /** Current server-mode phase. */
  phase:
    | "scraping"
    | "uploading"
    | "assembling"
    | "ready"
    | "failed"
    | "timeout"
    | null;
  /** Upload progress: completed count. */
  uploadCompleted: number;
  /** Upload progress: total count. */
  uploadTotal: number;
  /** Assembly phase label from server. */
  assemblyPhase: string | null;
  /** Assembly progress percentage (0-100). */
  assemblyProgressPct: number | null;
  /** Server download URL when ZIP is ready. */
  serverDownloadUrl: string | null;
  /** Whether the download is a single-file HTML. */
  isSingleFile: boolean;
  /** Server error details. */
  serverError: { error: string; canFallback: boolean; reason: string } | null;
}

export const initialServerModeState: ServerModeState = {
  phase: null,
  uploadCompleted: 0,
  uploadTotal: 0,
  assemblyPhase: null,
  assemblyProgressPct: null,
  serverDownloadUrl: null,
  isSingleFile: false,
  serverError: null,
};

// ---------------------------------------------------------------------------
// State transition reducer
// ---------------------------------------------------------------------------

/**
 * Apply a panel message to the current server-mode state and return
 * the new state.  Pure function — no side effects.
 *
 * @param prev   Current server-mode state
 * @param msgKey The `data.message.key` from the PANEL_MESSAGE action
 * @param options The `data.message.options` object (may be undefined)
 * @returns The new server-mode state
 */
export function applyServerModeMessage(
  prev: ServerModeState,
  msgKey: string,
  options?: Record<string, any> | null,
): ServerModeState {
  switch (msgKey) {
    // (15.7) Scraping → uploading transition
    case "status.sendingScrapeComplete":
    case "status.scrapeComplete":
    case "status.waitingForUploads":
      return { ...prev, phase: "uploading" };

    // Assembling phase
    case "status.finalizingServer":
    case "status.assemblingServer":
      return { ...prev, phase: "assembling" };

    // (15.2) Assembly progress updates
    case "status.assemblyProgress":
      return {
        ...prev,
        phase: "assembling",
        assemblyPhase: options?.phase ?? prev.assemblyPhase,
        assemblyProgressPct: options?.progressPct ?? prev.assemblyProgressPct,
      };

    // (15.1) Upload progress
    case "status.uploadProgress":
      return {
        ...prev,
        phase: prev.phase || "uploading",
        uploadCompleted: options?.completed ?? prev.uploadCompleted,
        uploadTotal: options?.total ?? prev.uploadTotal,
      };

    // (15.5 + 15.6) Server error / timeout
    case "status.serverError": {
      const reason = options?.reason ?? "server_unavailable";
      return {
        ...prev,
        phase: reason === "assembly_timeout" ? "timeout" : "failed",
        serverError: {
          error: options?.error ?? "Unknown error",
          canFallback: options?.canFallback ?? false,
          reason,
        },
      };
    }

    // Server fallback offer (from download-core.ts local fallback handler)
    case "status.serverFallbackOffer": {
      const reason = options?.reason ?? "server_unavailable";
      return {
        ...prev,
        phase: reason === "assembly_timeout" ? "timeout" : "failed",
        serverError: {
          error: options?.errorMessage ?? "",
          canFallback: true,
          reason,
        },
      };
    }

    // (15.3 + 15.4) Download ready — also accept download URL options
    // defensively so the UI is self-contained even if serverDownloadReady
    // was missed or processed out of order.
    case "status.complete":
      return {
        ...prev,
        phase: "ready",
        serverDownloadUrl: options?.downloadUrl ?? prev.serverDownloadUrl,
        isSingleFile: options?.isSingleFile ?? prev.isSingleFile,
      };

    // (15.3) Explicit download-ready signal with URL
    case "status.serverDownloadReady":
      return {
        ...prev,
        serverDownloadUrl: options?.downloadUrl ?? prev.serverDownloadUrl,
        isSingleFile: options?.isSingleFile ?? prev.isSingleFile,
      };

    // (15.7) Scraping phase
    case "status.scraping":
      return { ...prev, phase: "scraping" };

    // Unrecognised message — no state change
    default:
      return prev;
  }
}

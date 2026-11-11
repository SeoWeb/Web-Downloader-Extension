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
    | "paused"
    | "ready"
    | "failed"
    | "timeout"
    | "cancelled"
    | null;
  /** Upload progress: completed count. */
  uploadCompleted: number;
  /** Upload progress: total count. */
  uploadTotal: number;
  /**
   * (multipage-download-fixes 5.5) Per-page linked-scrape progress —
   * first-class state lifted from the `status.linkedPageProgress` pushes so
   * the scraping card can render a prominent "Page X of Y" counter (not
   * just a scrolling message-feed line). Null = no linked scrape in progress
   * → no counter renders.
   */
  linkedPageCurrent: number | null;
  linkedPageTotal: number | null;
  /** Which queue the linked loop is walking ("internal" | "external"). */
  linkedPagePhase: string | null;
  /** Assembly phase label from server. */
  assemblyPhase: string | null;
  /** Assembly progress percentage (0-100). */
  assemblyProgressPct: number | null;
  /**
   * Seconds elapsed since assembly started (assembly-timeout envelope,
   * task 6.1). Null when the server doesn't report it (older servers).
   */
  assemblyElapsedSeconds: number | null;
  /**
   * (multipage-download-fixes 5.7) True when the session options have
   * `downloadHtml=false` — the `merging_html` subtitle then explains the
   * merge prepares the text/markdown conversion instead of implying an
   * unexpected HTML download. Additive: absent flag keeps the previous
   * value (false for runs that never reported it — HTML wording).
   */
  assemblyForTextConversion: boolean;
  /** Server download URL when ZIP is ready. */
  serverDownloadUrl: string | null;
  /** Whether the download is a single-file HTML. */
  isSingleFile: boolean;
  /**
   * (D3) Number of resource uploads that failed permanently before the
   * download completed — 0 for a clean download. Reported additively via
   * the `status.complete` payload's `failedCount` option.
   */
  failedUploads: number;
  /**
   * (archive-warning-and-replace-fixes D2) The server's archive integrity
   * warning message (`archive_warning`), null for a clean session. Stored
   * additively from the `status.complete` / `status.serverDownloadReady`
   * payloads' `archiveWarning` option — absent option keeps the previous
   * value (same pattern as `failedUploads`).
   */
  archiveWarning: string | null;
  /**
   * Server session ID carried in the completion payloads so the panel's
   * delete flow can still target the session after the background has
   * cleared its in-memory active-session pointer on completion.
   */
  serverSessionId: string | null;
  /** Server error details. */
  serverError: { error: string; canFallback: boolean; reason: string } | null;
}

export const initialServerModeState: ServerModeState = {
  phase: null,
  uploadCompleted: 0,
  uploadTotal: 0,
  linkedPageCurrent: null,
  linkedPageTotal: null,
  linkedPagePhase: null,
  assemblyPhase: null,
  assemblyProgressPct: null,
  assemblyElapsedSeconds: null,
  assemblyForTextConversion: false,
  serverDownloadUrl: null,
  isSingleFile: false,
  failedUploads: 0,
  archiveWarning: null,
  serverSessionId: null,
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
    // (multipage-download-fixes 5.6 / D2) TRUE pause held — the scraper
    // blocked between pages. A dedicated `paused` phase renders the Paused
    // card (Resume + Stop); interrupted wording is never used for it.
    case "status.scraperPaused":
      return { ...prev, phase: "paused" };

    // (multipage-download-fixes 5.6) A park-resume re-spawns the scraper
    // and pushes this key — the phase returns to scraping (the Paused card
    // is replaced by the progress state, counter included).
    case "status.scrapingLinkedPages":
      return { ...prev, phase: "scraping" };

    // (multipage-download-fixes 5.5) Per-page counter — first-class state,
    // not just the message-feed subtitle.
    case "status.linkedPageProgress":
      return {
        ...prev,
        phase: "scraping",
        linkedPageCurrent:
          typeof options?.current === "number" ? options.current : null,
        linkedPageTotal:
          typeof options?.total === "number" ? options.total : null,
        linkedPagePhase:
          typeof options?.phase === "string"
            ? options.phase
            : prev.linkedPagePhase,
      };

    // (multipage-download-fixes 5.5) The linked phase ended — clear the
    // counter so no stale "Page X of Y" survives into the upload card.
    case "status.linkedPagesComplete":
    case "status.creatingPackage":
      return {
        ...prev,
        linkedPageCurrent: null,
        linkedPageTotal: null,
        linkedPagePhase: null,
      };

    // (15.7) Scraping → uploading transition
    case "status.sendingScrapeComplete":
    case "status.scrapeComplete":
    case "status.waitingForUploads":
      return { ...prev, phase: "uploading" };

    // Assembling phase
    case "status.finalizingServer":
    case "status.assemblingServer":
      return { ...prev, phase: "assembling" };

    // (15.2) Assembly progress updates. `elapsedSeconds` is additive
    // (task 6.1) — undefined-safe against servers that don't send it.
    // (multipage-download-fixes 5.7) `downloadHtml` is additive too: the
    // honest merge wording flag, threaded from the run's press-time
    // options snapshot. Absent → keep the previous value.
    case "status.assemblyProgress":
      return {
        ...prev,
        phase: "assembling",
        assemblyPhase: options?.phase ?? prev.assemblyPhase,
        assemblyProgressPct: options?.progressPct ?? prev.assemblyProgressPct,
        assemblyElapsedSeconds:
          typeof options?.elapsedSeconds === "number"
            ? options.elapsedSeconds
            : prev.assemblyElapsedSeconds,
        assemblyForTextConversion:
          typeof options?.downloadHtml === "boolean"
            ? !options.downloadHtml
            : prev.assemblyForTextConversion,
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
    // (D3) `failedCount` is additive: absent → keep the previous value
    // (0 for a clean download), so completion renders unchanged.
    // (archive-warning-and-replace-fixes D2) `archiveWarning` is additive
    // the same way — absent → keep the previous value (null for a clean
    // session).
    case "status.complete":
      return {
        ...prev,
        phase: "ready",
        // (multipage-download-fixes 5.5) Terminal — no counter survives.
        linkedPageCurrent: null,
        linkedPageTotal: null,
        linkedPagePhase: null,
        serverDownloadUrl: options?.downloadUrl ?? prev.serverDownloadUrl,
        isSingleFile: options?.isSingleFile ?? prev.isSingleFile,
        failedUploads:
          typeof options?.failedCount === "number"
            ? options.failedCount
            : prev.failedUploads,
        archiveWarning:
          typeof options?.archiveWarning === "string"
            ? options.archiveWarning
            : prev.archiveWarning,
        serverSessionId: options?.serverSessionId ?? prev.serverSessionId,
      };

    // (15.3) Explicit download-ready signal with URL.
    // (archive-warning-and-replace-fixes D2) `archiveWarning` is additive —
    // absent → keep the previous value.
    case "status.serverDownloadReady":
      return {
        ...prev,
        serverDownloadUrl: options?.downloadUrl ?? prev.serverDownloadUrl,
        isSingleFile: options?.isSingleFile ?? prev.isSingleFile,
        archiveWarning:
          typeof options?.archiveWarning === "string"
            ? options.archiveWarning
            : prev.archiveWarning,
        serverSessionId: options?.serverSessionId ?? prev.serverSessionId,
      };

    // (archive-warning-and-replace-fixes D1) Terminal cancelled phase — a
    // user stop resolves the server-mode UI. The salvaged archive URL and
    // every other field carry over from prev (the salvage probe's
    // status.serverDownloadReady has usually already stored them), so the
    // panel can render the stopped-with-partial-archive card. Never
    // "ready": a stop must not read as success.
    case "status.cancelled":
      return {
        ...prev,
        phase: "cancelled",
        // (multipage-download-fixes 5.5) Terminal — no counter survives.
        linkedPageCurrent: null,
        linkedPageTotal: null,
        linkedPagePhase: null,
      };

    // (15.7) Scraping phase
    case "status.scraping":
      return { ...prev, phase: "scraping" };

    // Unrecognised message — no state change
    default:
      return prev;
  }
}

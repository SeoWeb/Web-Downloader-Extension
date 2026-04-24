/**
 * Server Download Handler — manages the server-mode download lifecycle:
 * assembly polling, download triggering, and local fallback.
 *
 * Tasks 11.1–11.4 of the server-side-microservice migration.
 *
 * Key behaviors:
 * - (11.1) Replaces panel-download flow when server mode is active
 * - (11.2) Uses chrome.downloads.download with server URL and custom filename
 * - (11.3) Polls session status every 2s after finalize until ready/failed
 *          with a 5-minute timeout (AssemblyTimeoutError)
 * - (11.4) Offers local fallback when server fails or times out
 */

import {
  ServerClient,
  ServerUnavailableError,
  AuthenticationError,
  AssemblyTimeoutError,
  SessionStatusResponse,
  serverClient as defaultServerClient,
} from "./server-client";
import { trackDownload } from "./download-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a successful server download trigger. */
export interface ServerDownloadResult {
  /** The chrome.downloads.download ID. */
  downloadId: number;
  /** The server download URL used. */
  downloadUrl: string;
  /** Filename assigned to the download. */
  filename: string;
}

/** Callback type for status updates during assembly polling. */
export type AssemblyStatusCallback = (
  status: string,
  phase: string | null,
  progressPct: number | null,
) => void;

/** Callback type for offering local fallback to the user. */
export type LocalFallbackCallback = (
  reason: "server_unavailable" | "assembly_timeout" | "assembly_failed" | "auth_failed",
  errorMessage: string,
) => Promise<boolean>; // returns true if user chose local fallback

/** Thrown when the server reports that assembly has failed (status === "failed"). */
export class AssemblyFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyFailedError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000; // 2 seconds
const ASSEMBLY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// ServerDownloadHandler
// ---------------------------------------------------------------------------

/**
 * Handles the server-mode download lifecycle: after the extension finalizes
 * a session, this handler polls for assembly completion and triggers the
 * download via chrome.downloads.download when the ZIP is ready.
 *
 * Unlike the local-mode flow (which delegates to the side panel for blob URL
 * creation), server downloads use a direct URL — no panel delegation needed.
 */
export class ServerDownloadHandler {
  private readonly serverClient: ServerClient;

  /** AbortController for cancelling an in-progress polling loop. */
  private pollingAbortController: AbortController | null = null;

  constructor(serverClient: ServerClient) {
    this.serverClient = serverClient;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * (11.3) Poll the server for assembly completion after finalization.
   *
   * Polls `getSessionStatus` every 2 seconds until:
   * - status === "ready" → returns the session status (with download URL)
   * - status === "failed" → throws an error with the server's error message
   * - timeout (5 minutes) → throws AssemblyTimeoutError
   *
   * @param sessionId The server session ID to poll
   * @param onStatusUpdate Optional callback for progress updates during polling
   * @returns The final session status when assembly is complete
   */
  async pollAssemblyStatus(
    sessionId: string,
    onStatusUpdate?: AssemblyStatusCallback,
  ): Promise<SessionStatusResponse> {
    // Create a fresh AbortController for this polling session
    this.pollingAbortController = new AbortController();
    const signal = this.pollingAbortController.signal;

    const startTime = Date.now();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Check for cancellation
        if (signal.aborted) {
          throw new DOMException("Assembly polling was cancelled", "AbortError");
        }

        // Check for timeout
        const elapsed = Date.now() - startTime;
        if (elapsed >= ASSEMBLY_TIMEOUT_MS) {
          throw new AssemblyTimeoutError(
            `Server assembly did not complete within ${ASSEMBLY_TIMEOUT_MS / 1000} seconds. ` +
            "You can try again or download locally.",
          );
        }

        // Poll server status
        let status: SessionStatusResponse;
        try {
          status = await this.serverClient.getSessionStatus(sessionId);
        } catch (err) {
          // If the server is temporarily unreachable during polling,
          // we don't immediately fail — we continue polling until timeout.
          // This handles brief network blips gracefully.
          if (err instanceof ServerUnavailableError) {
            // Continue polling — the server may come back
          } else {
            // Non-transient errors (e.g. AuthenticationError) should propagate
            throw err;
          }

          // Wait before next poll and continue
          await sleep(POLL_INTERVAL_MS, signal);
          continue;
        }

        // Notify caller of current status
        onStatusUpdate?.(
          status.status,
          status.assembly_phase,
          status.assembly_progress_pct,
        );

        if (status.status === "ready") {
          return status;
        }

        if (status.status === "failed") {
          const errorMsg = status.error_message ?? "Server assembly failed with no error message";
          throw new AssemblyFailedError(`Assembly failed: ${errorMsg}`);
        }

        // Status is still "assembling" (or transitional) — wait and poll again
        await sleep(POLL_INTERVAL_MS, signal);
      }
    } finally {
      this.pollingAbortController = null;
    }
  }

  /**
   * (11.2) Trigger a download from the server URL using chrome.downloads.download.
   *
   * Unlike local-mode downloads that require panel delegation for blob URLs,
   * server downloads use a direct HTTP URL that Chrome can download natively.
   * No side panel interaction is needed.
   *
   * The download URL is validated: if it uses `http://` with a non-loopback
   * host, a console warning is logged (the user was already warned at
   * configuration time per S6).
   *
   * @param downloadUrl The server download URL (from session status)
   * @param filename The desired filename for the download
   * @param tabId Optional tab ID for download tracking
   * @returns The chrome.downloads.download ID
   */
  async triggerServerDownload(
    downloadUrl: string,
    filename: string,
    tabId?: number,
  ): Promise<number> {
    // Validate the download URL scheme
    this.warnIfHttpDownload(downloadUrl);

    // Use chrome.downloads.download with the server URL directly.
    // No blob URL or panel delegation needed — the URL is a regular HTTP(S) URL.
    const chromeDownloadId = await new Promise<number>((resolve, reject) => {
      chrome.downloads.download(
        {
          url: downloadUrl,
          filename,
          saveAs: true,
        },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(
              new Error(
                `chrome.downloads.download failed: ${chrome.runtime.lastError.message}`,
              ),
            );
          } else if (id === undefined) {
            reject(new Error("chrome.downloads.download returned undefined ID"));
          } else {
            resolve(id);
          }
        },
      );
    });

    // Track the download for completion detection
    doTrackDownload(chromeDownloadId, filename, tabId);

    return chromeDownloadId;
  }

  /**
   * (11.1 + 11.3) Full server download lifecycle:
   * finalize → poll → download.
   *
   * Convenience method that combines pollAssemblyStatus and triggerServerDownload
   * into a single call. The caller must have already called
   * ServerClient.finalizeSession() before invoking this method.
   *
   * @param sessionId The server session ID
   * @param tabUrl The original page URL (used to derive the filename)
   * @param isSingleFile Whether the output is a single HTML file (vs ZIP)
   * @param onStatusUpdate Optional callback for assembly progress updates
   * @param tabId Optional tab ID for download tracking
   * @returns ServerDownloadResult with the download ID, URL, and filename
   */
  async waitForDownload(
    sessionId: string,
    tabUrl: string,
    isSingleFile: boolean,
    onStatusUpdate?: AssemblyStatusCallback,
    tabId?: number,
  ): Promise<ServerDownloadResult> {
    // Poll until assembly is complete
    const status = await this.pollAssemblyStatus(sessionId, onStatusUpdate);

    // Extract download URL from status
    const downloadUrl = status.download_url;
    if (!downloadUrl) {
      throw new ServerUnavailableError(
        "Assembly completed but no download URL returned by server",
      );
    }

    // Derive a safe filename from the URL
    const filename = deriveFilename(tabUrl, isSingleFile);

    // Trigger the download
    const chromeDownloadId = await this.triggerServerDownload(
      downloadUrl,
      filename,
      tabId,
    );

    return {
      downloadId: chromeDownloadId,
      downloadUrl,
      filename,
    };
  }

  /**
   * (11.4) Execute the full server download flow with local fallback support.
   *
   * After finalization, polls for assembly completion. If the server fails,
   * becomes unavailable, or assembly times out, the localFallbackCallback
   * is invoked to offer the user a local download option.
   *
   * @param sessionId The server session ID
   * @param tabUrl The original page URL (used for filename derivation)
   * @param isSingleFile Whether the output is a single HTML file
   * @param onLocalFallback Callback to offer the user a local fallback option
   * @param onStatusUpdate Optional callback for assembly progress updates
   * @param tabId Optional tab ID for download tracking
   * @returns ServerDownloadResult, or null if the user chose local fallback
   */
  async downloadWithFallback(
    sessionId: string,
    tabUrl: string,
    isSingleFile: boolean,
    onLocalFallback: LocalFallbackCallback,
    onStatusUpdate?: AssemblyStatusCallback,
    tabId?: number,
  ): Promise<ServerDownloadResult | null> {
    try {
      return await this.waitForDownload(
        sessionId,
        tabUrl,
        isSingleFile,
        onStatusUpdate,
        tabId,
      );
    } catch (err) {
      // Categorize the error and offer local fallback
      let reason: "server_unavailable" | "assembly_timeout" | "assembly_failed" | "auth_failed";
      let errorMessage: string;

      if (err instanceof AssemblyTimeoutError) {
        reason = "assembly_timeout";
        errorMessage =
          "Server assembly is taking too long. You can try again or download locally.";
      } else if (err instanceof AssemblyFailedError) {
        reason = "assembly_failed";
        errorMessage = err.message;
      } else if (err instanceof ServerUnavailableError) {
        reason = "server_unavailable";
        errorMessage =
          "Server is unavailable. You can try again when the server is back, or download locally.";
      } else if (err instanceof AuthenticationError) {
        reason = "auth_failed";
        errorMessage =
          "Authentication failed. You can try again or download locally.";
      } else {
        reason = "assembly_failed";
        errorMessage =
          err instanceof Error ? err.message : "An unknown error occurred during server download.";
      }

      // Offer the user a local fallback option
      const choseLocal = await onLocalFallback(reason, errorMessage);

      if (choseLocal) {
        // User chose local fallback — return null so the caller can
        // restart the download using the local pipeline.
        // The caller is responsible for re-scraping the page (with warning).
        return null;
      }

      // User did not choose local fallback — re-throw the error
      throw err;
    }
  }

  /**
   * Cancel an in-progress assembly polling loop.
   * Does not affect downloads that have already been triggered.
   */
  cancelPolling(): void {
    if (this.pollingAbortController) {
      this.pollingAbortController.abort();
      this.pollingAbortController = null;
    }
  }

  // -----------------------------------------------------------------------
  // HTTPS warning (S6 note)
  // -----------------------------------------------------------------------

  /**
   * Warn if the download URL uses http:// with a non-loopback host.
   * Chrome blocks mixed-content downloads from HTTP remote origins.
   * The user was already warned at configuration time, but this serves
   * as an additional runtime reminder.
   */
  private warnIfHttpDownload(downloadUrl: string): void {
    try {
      const url = new URL(downloadUrl);
      if (url.protocol === "http:") {
        const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(
          url.hostname,
        );
        if (!isLoopback) {
          console.warn(
            `[ServerDownloadHandler] WARNING: Download URL uses http:// with ` +
            `non-loopback host (${url.hostname}). ` +
            "Chrome may block this download. HTTPS is mandatory for non-localhost deployments.",
          );
        }
      }
    } catch {
      // Invalid URL — ignore
    }
  }
}

/** Singleton instance for use throughout the extension background context. */
let _serverDownloadHandler: ServerDownloadHandler | null = null;

/**
 * Get the singleton ServerDownloadHandler instance.
 * Lazily initialized to avoid circular dependency at module load time.
 */
export function getServerDownloadHandler(): ServerDownloadHandler {
  if (!_serverDownloadHandler) {
    _serverDownloadHandler = new ServerDownloadHandler(defaultServerClient);
  }
  return _serverDownloadHandler;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a safe filename from the URL, matching the format used by the
 * server's _derive_filename() and the local download-core.ts logic.
 *
 * Format: hostname-path-timestamp.zip or hostname-path-timestamp.html
 * Max length: 200 characters.
 */
function deriveFilename(tabUrl: string, isSingleFile: boolean): string {
  const extension = isSingleFile ? ".html" : ".zip";

  try {
    const u = new URL(tabUrl);

    // Remove www prefix
    const domain = u.hostname.replace(/^www\./i, "");

    // Clean hostname: allow only alphanumeric, dots, and hyphens
    const hostname = domain.replace(/[^a-z0-9.-]/gi, "_") || "website";

    // Clean path: allow only alphanumeric, dots, and hyphens
    const pathParts = u.pathname
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => part.replace(/[^a-z0-9.-]/gi, "-"));

    let safePath = pathParts.join("-");
    if (safePath.length > 50) {
      safePath = safePath.substring(0, 50);
    }

    const baseName = safePath ? `${hostname}-${safePath}` : hostname;
    // Use Unix epoch seconds to match the server-side _derive_filename()
    const timestamp = Math.floor(Date.now() / 1000);

    const maxBase = 200 - extension.length;
    return `${baseName}-${timestamp}`.substring(0, maxBase) + extension;
  } catch {
    // Fallback for invalid URLs
    return `website-${Date.now()}${extension}`;
  }
}

/**
 * Sleep for the specified duration. Resolves early if the abort signal fires.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Track a chrome download for completion detection.
 * Reuses the same tracking mechanism as panel-download.ts.
 */
function doTrackDownload(id: number, filename: string, tabId?: number): void {
  trackDownload(id, filename, tabId);
}

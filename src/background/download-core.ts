import { getResources } from "./resources";
import { memoryManager } from "../utils/MemoryManager";
import { requestQueue } from "../utils/RequestQueue";
import { cleanupAfterDownload } from "./cleanupHandlers";
import { FilterOptions } from "../types/filterTypes";
import {
  setTabDownloadActive,
  setTabDownloadComplete,
  isTabDownloadInProgress,
  isOtherDownloadActive,
  setDownloadAbortController,
  getDownloadAbortController,
  createKeepalivePort,
  disconnectKeepalivePort,
  createDownloadContext,
  markSessionLive,
  markSessionNotLive,
  setSessionUploadQueue,
  setSessionPhase,
  setSessionLastError,
  type DownloadContext,
} from "./download-state";
import {
  writeCheckpoint,
  updateCheckpointPhase,
  updateCheckpointResourceUrls,
  clearCheckpoint,
} from "./download-checkpoint";
import { performInitialCleanup } from "./download-utils";

class PanelUnavailableError extends Error {
  constructor(message: string = "Extension panel is not available") {
    super(message);
    this.name = "PanelUnavailableError";
  }
}

import {
  mergeFilenameMaps,
  processAssets,
  processDocuments,
  processImages,
  type HandlerOptions,
} from "./download-processors";
import { sumResourceFailures, type ResourceFailureTally } from "./urlUtils";
import { AssetRegistry, buildArchivePath } from "./asset-registry";
import { LinkedPageScraper } from "./linked-page-scraper";
import { ServerStorageAdapter } from "./storage/server-storage-adapter";
import {
  serverClient,
  ServerUnavailableError,
  AuthenticationError,
  AssemblyTimeoutError,
  HttpError,
  upgradeInsecureServerUrl,
  type SessionOptions,
} from "./server-client";
import { UploadQueue } from "./upload-queue";
import {
  getServerDownloadHandler,
  AssemblyFailedError,
} from "./server-download";
import { setCurrentScraper, stopScraping } from "./scraper-state";
import {
  setActiveServerSession,
  getActiveServerSessionId,
  hasStreamedHtmlChunks,
} from "./message";
import { loadFilterOptions } from "../common/storage/filterStorage";
import {
  PAGEPOCKET_CLOUD_ENABLED_KEY,
  PAGEPOCKET_AUTH_STORAGE_KEY,
  type PagePocketAuthState,
} from "../types/authTypes";
import { ensureCloudBinding, getCloudBinding } from "./cloud-binding";

const EMPTY_MAP: Map<string, string> = new Map();

/**
 * (D7 / task 1.3) Promise.allSettled with a safety bound.
 *
 * Behaves like Promise.allSettled while every promise settles within
 * `boundMs`. If the bound elapses first, the wait is RELEASED: categories
 * that already settled keep their real outcome, categories that have not
 * settled are reported as REJECTED with a synthetic timeout error, so a
 * single stalled category (e.g. a request queue paused forever) cannot hold
 * finalization hostage. Late settle/reject of an abandoned category is
 * recorded into the local array and otherwise ignored (no unhandled
 * rejection). The timer is cleared in `finally` — no stray timer outlives
 * the wait. Exported for unit testing (download-liveness.test.ts).
 */
export async function allSettledWithBound<T>(
  promises: Promise<T>[],
  boundMs: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: Array<PromiseSettledResult<T> | undefined> = new Array(
    promises.length,
  );
  const trackers = promises.map((promise, index) =>
    promise.then(
      (value) => {
        results[index] = { status: "fulfilled", value };
      },
      (reason) => {
        results[index] = { status: "rejected", reason };
      },
    ),
  );

  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<PromiseSettledResult<T>[]>((resolve) => {
    boundTimer = setTimeout(() => {
      // NB: build the output from the INDICES — a plain results.map() would
      // preserve the empty slots of the sparse array as holes instead of
      // running the fallback for them.
      resolve(
        promises.map((_promise, index) => {
          const result: PromiseSettledResult<T> | undefined = results[index];
          return (
            result ?? {
              status: "rejected",
              reason: new Error(
                "Asset-category wait exceeded its safety bound",
              ),
            }
          );
        }),
      );
    }, boundMs);
  });

  const allSettled = Promise.all(trackers).then(
    () => results as PromiseSettledResult<T>[],
  );

  try {
    return await Promise.race([allSettled, bound]);
  } finally {
    clearTimeout(boundTimer);
  }
}

/** Shape of getResources()' result needed for the zero-content decision. */
interface ExtractedResources {
  css: string[];
  js: string[];
  documents: string[];
  images: string[];
  links: string[];
  text: string;
}

/**
 * (Fix C — zero-content abort) Decide whether a MAIN-flow download would
 * produce an EMPTY server session — the condition that created the
 * "successful" 0-resource downloads / empty pushed pages from the incident.
 *
 * A download is considered empty when ALL of the following hold:
 *   - no resources would actually be uploaded (each category is only
 *     non-empty when its download flag is enabled),
 *   - the HTML page itself is not part of the output (downloadHTML off),
 *   - no text document would be produced (text flag on AND extracted text
 *     non-empty) and no markdown document was requested (the server
 *     derives content.md from the uploaded HTML regardless of downloadHtml),
 *   - linked-page scraping would not produce content either (flag off, or
 *     no links discovered).
 *
 * Pure function — exported for unit testing.
 */
export function isEmptyDownload(
  downloadOptions: FilterOptions,
  data: ExtractedResources,
): boolean {
  // 1. Any actually-uploaded resource counts as content.
  const hasResources =
    (downloadOptions.downloadImages && data.images.length > 0) ||
    (downloadOptions.downloadAssets &&
      (data.css.length > 0 || data.js.length > 0)) ||
    (downloadOptions.downloadDocuments && data.documents.length > 0);
  if (hasResources) return false;

  // 2. The HTML page itself is content.
  if (downloadOptions.downloadHTML !== false) return false;

  // 3. Text / markdown documents are content.
  if (downloadOptions.downloadContentAsText && data.text.trim().length > 0) {
    return false;
  }
  if (downloadOptions.downloadContentAsMarkdown) return false;

  // 4. Linked-page scraping would still produce content.
  if (downloadOptions.downloadLinksFullScraping && data.links.length > 0) {
    return false;
  }

  return true;
}

/**
 * Resolve the PagePocket credential for cloud-mode session creation
 * (task 6.5 / design D4 — harden-backend-security-and-ops).
 *
 * The cloud push identity is a SERVER-side binding (POST /api/v1/cloud/link
 * stamped it on the API-key client row). The credential sent in
 * `options.pagepocketUserId` is now only a hint:
 *
 * 1. Binding `bound`   → send the BOUND id (matches the server binding, so a
 *                        new monolith accepts it, and an older monolith that
 *                        still trusts this field keeps working unchanged).
 * 2. Binding `unsupported` (older monolith without /cloud/link, or its
 *                        binding service unconfigured) → legacy behavior:
 *                        send the raw authenticated user id.
 * 3. No binding state yet (login link still in flight or failed transiently)
 *                      → try to link once, then fall back to the raw id — a
 *                        new server answers 403 cloud_not_linked, which the
 *                        session-creation wrapper below turns into a forced
 *                        re-bind + retry.
 *
 * Returns undefined when cloud mode is off or there is no authenticated
 * PagePocket user — the server creates a normal (non-cloud) session.
 */
export async function resolveCloudCredential(): Promise<string | undefined> {
  try {
    // D11: auth state and the cloud toggle live in chrome.storage.session
    // (never on disk).
    if (!chrome?.storage?.session) return undefined;
    const result = await chrome.storage.session.get([
      PAGEPOCKET_CLOUD_ENABLED_KEY,
      PAGEPOCKET_AUTH_STORAGE_KEY,
    ]);
    const cloudEnabled = result[PAGEPOCKET_CLOUD_ENABLED_KEY] === true;
    const auth = result[PAGEPOCKET_AUTH_STORAGE_KEY] as
      | PagePocketAuthState
      | undefined;
    if (!(cloudEnabled && auth?.accessToken && auth?.user?.id)) {
      return undefined;
    }

    const binding = await getCloudBinding();
    if (binding?.status === "bound") {
      return binding.pagepocketUserId;
    }
    if (binding?.status === "unsupported") {
      // Graceful degradation (task 6.5): keep cloud mode working against an
      // un-upgraded server via the legacy raw-pagepocketUserId behavior.
      return auth.user.id;
    }

    // Binding missing/unknown — attempt the link flow once (no-op when the
    // login-time link already stored the binding by now).
    const linked = await ensureCloudBinding();
    if (linked?.status === "bound") {
      return linked.pagepocketUserId;
    }
    return auth.user.id;
  } catch {
    return undefined;
  }
}

/**
 * Create the server session, handling the monolith's binding enforcement
 * (task 6.5). A 403 `cloud_not_linked` means the server-side client row has
 * no binding although the extension believed it was bound — the row was
 * replaced by a re-registration or a server redeploy. Re-run the link flow
 * (forced) and retry ONCE with the freshly bound identity; any other error
 * (including cloud_identity_mismatch) propagates to the caller's mapping.
 */
export async function createSessionWithCloudRetry(
  url: string,
  options: SessionOptions,
): Promise<string> {
  try {
    return await serverClient.createSession(url, options);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.statusCode === 403 &&
      error.errorCode === "cloud_not_linked"
    ) {
      console.warn(
        "[ServerMode] cloud_not_linked from session creation — re-running the binding flow",
      );
      const rebound = await ensureCloudBinding({ force: true });
      if (rebound?.status === "bound") {
        return serverClient.createSession(url, {
          ...options,
          pagepocketUserId: rebound.pagepocketUserId,
        });
      }
    }
    throw error;
  }
}

/**
 * Best-effort lookup of a concrete fallback URL for a session that failed
 * during assembly. If the server already produced a download URL, the panel
 * can offer a direct local-fallback action with it (UX contract, task 5.2).
 */
async function lookupFallbackUrl(
  sessionId: string,
): Promise<string | undefined> {
  try {
    const status = await serverClient.getSessionStatus(sessionId);
    // Self-heal a same-host http:// scheme (TLS-terminating proxy
    // misconfig — see upgradeInsecureServerUrl) before the URL reaches the
    // panel's local-fallback action.
    return status?.download_url
      ? upgradeInsecureServerUrl(status.download_url, serverClient.baseUrl)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * (stop-cancel-semantics D2) AbortError discriminator — the same convention
 * `downloadWithFallback` uses to let a cancelled poll pass through without
 * the fallback offer (server-download.ts): a DOMException/Error named
 * "AbortError" is a cancellation, not a failure. Note `AbortSignal.timeout()`
 * rejects with "TimeoutError" instead, so per-resource timeouts correctly do
 * NOT match.
 */
function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/**
 * (design D6 / tasks 6.1–6.2) Fire-and-forget panel push.
 *
 * The injected `sendMessage` callback returns the panel-delivery promise
 * (messageWorker's addMessage → sendMessageToPanel), so when the side panel
 * is closed every push rejects with "Receiving end does not exist". Catch
 * and log those failures at debug level — mirroring listenMessage's catch in
 * src/common/chrome.ts — so a failed push never becomes an unhandled
 * rejection in the service worker and never affects the download pipeline.
 * A successful push behaves exactly as the bare call did.
 */
function pushToPanelSafely(
  sendMessage: (message: string | { key: string; options?: any }) => unknown,
  message: string | { key: string; options?: any },
): void {
  try {
    Promise.resolve(sendMessage(message)).catch((err) => {
      console.debug(
        "[download-core] panel push failed (ignored):",
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    console.debug(
      "[download-core] panel push failed (ignored):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * (stop-cancel-semantics D1 / tasks 2.4 + 3.4) Terminal salvage report for a
 * user-stopped download: ONE cheap status probe (the `lookupFallbackUrl`
 * pattern). When the server already produced the archive, its URL is
 * surfaced via the existing `status.serverDownloadReady` affordance
 * (self-healed) alongside `status.cancelled`; when not, the plain
 * cancellation is reported and the session is left to server retention.
 *
 * Never polls and never throws — a probe failure degrades to the plain
 * cancellation. The assembly-poll abort (both paths) and the main-path
 * stop catch report through this helper.
 */
async function reportCancelledSession(
  sessionId: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  options: { failedCount?: number } = {},
): Promise<void> {
  const downloadUrl = await lookupFallbackUrl(sessionId);
  if (downloadUrl) {
    pushToPanelSafely(sendMessage, {
      key: "status.serverDownloadReady",
      options: { downloadUrl, serverSessionId: sessionId },
    });
  }
  pushToPanelSafely(sendMessage, {
    key: "status.cancelled",
    options: {
      serverSessionId: sessionId,
      ...(typeof options.failedCount === "number"
        ? { failedCount: options.failedCount }
        : {}),
    },
  });
}

export async function downloadResources(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  _assemblyJobId?: string,
  tabId?: number,
) {
  if (!tabUrl) {
    // en.json keeps these under `app.*` (not `error.*`) — emit the keys the
    // UI can actually resolve through t().
    pushToPanelSafely(sendMessage, { key: "app.noUrl" });
    return;
  }

  // Prevent concurrent downloads per-tab
  if (tabId && isTabDownloadInProgress(tabId)) {
    pushToPanelSafely(sendMessage, { key: "app.downloadInProgress" });
    return;
  }

  // Server session id — assigned once created; the finally block uses it to
  // clear ONLY this download's checkpoint (per-download keying, design D4.4).
  let serverSessionId: string | undefined;

  // Memory check — server mode threshold (100MB available)
  const initialMemoryStats = memoryManager.getMemoryStats();
  const availableMemoryBytes =
    initialMemoryStats.totalMemoryLimit - initialMemoryStats.totalMemoryUsed;
  const availableMemoryMB = availableMemoryBytes / (1024 * 1024);
  if (availableMemoryMB < 100) {
    pushToPanelSafely(sendMessage, { key: "app.memoryPressure" });
    return;
  }
  if (availableMemoryMB < 256) {
    pushToPanelSafely(sendMessage, {
      key: "status.memoryWarningServerMode",
      options: { availableMB: Math.round(availableMemoryMB) },
    });
  }

  await setTabDownloadActive(tabId!);

  // (D7 / task 4.1) Per-download context — replaces the module-global
  // filename map and shared mutable state so concurrent tab downloads
  // cannot corrupt each other. Declared before the try so the finally
  // block can clean up with it.
  const context = createDownloadContext({
    tabId,
    tabUrl,
    abortController: new AbortController(),
  });

  try {
    createKeepalivePort(tabId!);

    // Read the PagePocket cloud credential if cloud mode is enabled.
    // When set, the server will push the assembled result to PagePocket
    // instead of creating a ZIP file (identity sourced from the server-side
    // binding — task 6.5 / D4).
    const pagepocketUserId = await resolveCloudCredential();

    // Create server session (reuse existing if created during INITIALIZE_DIFFERENTIAL_SCRAPING)
    const existingSessionId = getActiveServerSessionId(tabId!);
    if (existingSessionId) {
      serverSessionId = existingSessionId;
    } else {
      serverSessionId = await createSessionWithCloudRetry(tabUrl, {
        singleFile: downloadOptions?.singleFile ?? false,
        downloadContentAsMarkdown:
          downloadOptions?.downloadContentAsMarkdown ?? false,
        // text-native-downloads 6.1: forward the full format selection so
        // the assembler can honor "HTML off" (text-only output) and
        // content.txt as a standalone format.
        downloadHtml: downloadOptions?.downloadHTML ?? true,
        downloadContentAsText: downloadOptions?.downloadContentAsText ?? false,
        retentionDays: 1,
        pagepocketUserId: pagepocketUserId ?? undefined,
      });
      setActiveServerSession(tabId!, serverSessionId);
    }
    context.serverSessionId = serverSessionId;

    const storage = new ServerStorageAdapter(serverClient);
    storage.setSessionId(serverSessionId);

    // Write interrupt checkpoint
    await writeCheckpoint({
      phase: "scraping",
      serverSessionId,
      tabId,
      tabUrl,
    });

    // Register the download-level abort controller (user presses Stop)
    setDownloadAbortController(context.abortController, tabId!);

    await performInitialCleanup();
    await executeDownloadServerMode(
      html,
      tabUrl,
      downloadOptions,
      sendMessage,
      storage,
      serverSessionId,
      tabId,
      context,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // (Round 9 — Fix B) Record the terminal error so the panel's
    // CHECK_DOWNLOAD_LIVE poll can surface the failure even when its
    // failure push was dropped by a tab switch. Only possible when a
    // session exists — a failed session CREATION has no key to record under.
    // (stop-cancel-semantics D1) A user stop is not a failure — don't
    // record one.
    if (serverSessionId && !isAbortError(error)) {
      setSessionLastError(serverSessionId, errorMessage);
    }

    let userFriendlyMessage: string | { key: string; options?: any } = {
      key: "status.failedWithError",
      options: { error: errorMessage },
    };
    let isMemoryError = false;

    if (error instanceof PanelUnavailableError) {
      userFriendlyMessage = { key: "app.panelUnavailable" };
    } else if (isAbortError(error)) {
      // (stop-cancel-semantics D1/2.2) A stop-induced AbortError is user
      // intent, not a failure — report the cancellation, never
      // status.failedWithError("Download was cancelled"). This covers the
      // pre-flow window (Stop pressed while the session is still being
      // created, before executeDownloadServerMode's own wiring); stops
      // inside the flow are salvaged and reported by
      // executeDownloadServerMode itself. Nothing to salvage here — the
      // session (if any) is empty and left to server retention.
      userFriendlyMessage = {
        key: "status.cancelled",
        ...(serverSessionId ? { options: { serverSessionId } } : {}),
      };
    } else if (
      error instanceof HttpError &&
      error.statusCode === 403 &&
      error.errorCode === "cloud_not_linked"
    ) {
      // Task 6.5: the monolith refused cloud mode because this client has no
      // PagePocket binding (re-bind + retry already attempted above).
      userFriendlyMessage = { key: "status.cloudNotLinked" };
    } else if (
      error instanceof HttpError &&
      error.statusCode === 403 &&
      error.errorCode === "cloud_identity_mismatch"
    ) {
      // Task 6.5: the sent id diverges from the server-side binding — the
      // user must re-authenticate to resolve the conflict.
      userFriendlyMessage = { key: "status.cloudIdentityMismatch" };
    } else if (
      error instanceof AuthenticationError ||
      error instanceof ServerUnavailableError
    ) {
      userFriendlyMessage = {
        key: "status.serverError",
        options: {
          error: error.message.split("\n")[0],
          canFallback: true,
          reason: "server_unavailable",
        },
      };
    } else if (
      errorMessage.includes("memory") ||
      errorMessage.includes("size") ||
      errorMessage.includes("limit") ||
      errorMessage.includes("quota")
    ) {
      isMemoryError = true;
      userFriendlyMessage = { key: "status.memoryLimitError" };
    } else if (
      errorMessage.includes("network") ||
      errorMessage.includes("fetch") ||
      errorMessage.includes("connection") ||
      errorMessage.includes("offline")
    ) {
      userFriendlyMessage = { key: "status.networkError" };
    }

    pushToPanelSafely(sendMessage, userFriendlyMessage);

    if (isMemoryError) {
      // forceCleanup runs the registered cleanup callbacks, which clear the
      // SHARED request queue — while another download is active that would
      // destroy its in-flight/queued state. Its own teardown will run the
      // global cleanup once it is the last download.
      if (!isOtherDownloadActive(tabId)) {
        await memoryManager.forceCleanup();
      }
      pushToPanelSafely(sendMessage, { key: "status.memoryCleanupPerformed" });
    }
  } finally {
    await setTabDownloadComplete(tabId!);
    setDownloadAbortController(null, tabId!);
    disconnectKeepalivePort(tabId!);
    // Per-download checkpoint keying (design D4.4): clear ONLY this
    // download's checkpoint — a concurrent download's checkpoint must
    // survive. Skip entirely when no session was created (nothing was
    // written for this download).
    if (serverSessionId) {
      await clearCheckpoint(serverSessionId);
    }

    // (Concurrent-downloads spec / design D7) Teardown must never destroy
    // another active download's state. The RequestQueue is a SHARED
    // singleton: full-clearing it aborts the peer's in-flight fetches and
    // drops its queued requests (leaving handler promises pending forever —
    // the peer then never reaches scrape-complete/finalize). So only the
    // LAST finishing download performs the global cleanup; everyone else
    // purges just its own scoped state. `setTabDownloadComplete` above
    // already removed this download from the active set.
    try {
      if (isOtherDownloadActive(tabId)) {
        requestQueue.clearDownload(context.downloadId);
      } else {
        await cleanupAfterDownload(context.downloadId);
        requestQueue.clear();
      }
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Server-mode download flow
// ---------------------------------------------------------------------------

/**
 * (12.1–12.9) Server-mode download flow.
 *
 * Server-mode download pipeline:
 * HTML chunk upload → resource upload → filename map upload →
 * scrape-complete → finalize → poll → chrome.downloads.download.
 *
 * On server failure (unavailable, auth error, assembly timeout/failed),
 * offers the user a local fallback option with a re-scrape warning.
 */
async function executeDownloadServerMode(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  storage: ServerStorageAdapter,
  sessionId: string,
  tabId: number | undefined,
  context: DownloadContext,
): Promise<void> {
  const uploadQueue = storage.getUploadQueue();
  context.uploadQueue = uploadQueue;
  context.serverSessionId = sessionId;

  // (Fix D.1 — liveness) Mark this session as LIVE for the whole flow so
  // the panel can distinguish "download still running" from "interrupted —
  // offer Resume/Restart" when it (re)opens and finds a checkpoint.
  // (Round 9 — Fix B) Also record the run's tab + phase and attach the
  // upload queue so the panel's CHECK_DOWNLOAD_LIVE poll reads trustworthy
  // progress from here instead of relying on lossy pushed messages.
  markSessionLive(sessionId, { tabId, phase: "uploading" });
  setSessionUploadQueue(sessionId, uploadQueue);

  // Link the download-level abort controller to the upload queue
  // so that pressing Stop aborts in-flight uploads.
  const downloadAbort = context.abortController;
  {
    // If already aborted before we start, exit immediately
    if (downloadAbort.signal.aborted) {
      throw new DOMException("Download was cancelled", "AbortError");
    }
    // When the download-level controller aborts, cancel the upload queue AND
    // abort the assembly-poll signal (stop-cancel-semantics D2 / task 1.1) —
    // pressing Stop must also wake pollAssemblyStatus's abortable sleep
    // immediately instead of letting it run to its next tick or the
    // 35-minute cap.
    downloadAbort.signal.addEventListener(
      "abort",
      () => {
        uploadQueue.cancel();
        context.assemblyAbortController.abort();
      },
      { once: true },
    );
  }

  // (15.1) Wire up upload progress reporting so the UI can show
  // "X/Y resources uploaded" during the server-mode download.
  uploadQueue.onProgress = (progress) => {
    pushToPanelSafely(sendMessage, {
      key: "status.uploadProgress",
      options: {
        completed: progress.completedCount,
        total: progress.totalCount,
        bytesUploaded: progress.bytesUploaded,
        totalBytes: progress.totalBytes,
      },
    });
  };

  // When the 500MB session limit is hit, stop scraping and proceed to
  // finalize with whatever was successfully uploaded.
  uploadQueue.onSessionFull = (_sessionId: string) => {
    console.warn(
      `[ServerMode] Session size limit reached for ${_sessionId}. ` +
        `Stopping scraper and proceeding to finalize with partial data.`,
    );
    if (tabId) {
      stopScraping(tabId);
    }
    pushToPanelSafely(sendMessage, { key: "status.sessionSizeLimitReached" });
  };

  // Track total resources for scrape-complete signal
  let totalResourceCount = 0;
  let scrapeCompleteSent = false;
  // (D6) True when uploadQueue.waitForAll() resolved cleanly (no user abort,
  // no drain timeout) — lets the finally block below skip the safety-net
  // cancel() so a fully successful download doesn't log a spurious
  // "0 active + 0 pending uploads aborted" warning.
  let uploadsDrainedCleanly = false;
  // Per-category failed-fetch tally, filled by the file handlers via
  // HandlerOptions.failureTally and reported as `resourcesFailed` on
  // scrape-complete. Declared here so the catch path's best-effort
  // scrapeComplete can also report what failed before the error.
  const resourceFailureTally: ResourceFailureTally = {};

  try {
    // Extract resources from the HTML (moved above the HTML chunk upload so
    // the zero-content abort below can skip the upload entirely — an
    // aborted session must not leave a skeleton chunk on the server).
    const data = getResources(html);

    // (Fix C — zero-content abort) A main-flow download whose session would
    // be completely EMPTY (no resources, no HTML output, no text/markdown
    // document, nothing from linked pages) is aborted here — before
    // scrapeComplete/finalize — instead of producing one of the instant
    // "successful" 0-resource downloads that pushed empty pages. The user
    // gets a clear retry hint through the panel's status path (mirrors the
    // pagepocketUploadError surfacing below). The server session is left to
    // its normal retention cleanup; the checkpoint is cleared by the outer
    // finally in downloadResources().
    if (isEmptyDownload(downloadOptions, data)) {
      console.warn(
        "[ServerMode] Zero-content download aborted (no resources, HTML off, no text/markdown document).",
      );
      // (Round 9 — Fix B) The abort IS the terminal outcome — record it so
      // the panel's final poll surfaces it instead of faking a completion
      // when the noDownloadableContent push was dropped by a tab switch.
      setSessionLastError(
        sessionId,
        "No downloadable content found — the page may not have finished loading.",
      );
      pushToPanelSafely(sendMessage, { key: "status.noDownloadableContent" });
      return;
    }

    // (12.3) Upload main page HTML as chunk to the server.
    // scrollIndex 0 = first (and only) chunk for the main page.
    //
    // (13.3 / START_DOWNLOAD lastSnapshot policy) SKIP the re-upload when
    // HTML chunks were already streamed to the server during scrolling
    // (via SERVER_UPLOAD_HTML_CHUNK). The sidepanel streams EVERY scroll
    // step's full document (indices 0..N-1) — including the final settled
    // DOM — and START_DOWNLOAD receives that same last chunk's HTML
    // verbatim (the panel's lastHtml is only set after a successful
    // stream), so a re-upload would be a redundant duplicate.
    // hasStreamedHtmlChunks() (message.ts) truthfully tracks
    // explicit-index streams. When nothing was streamed (no pre-created
    // session, or a caller that never streams), this chunk-0 upload is
    // what initializes the server skeleton and must run unchanged.
    if (!hasStreamedHtmlChunks(tabId!)) {
      pushToPanelSafely(sendMessage, { key: "status.uploadingHtml" });
      // Do NOT send tabUrl as pageUrl for main page — the server uses
      // the absence of pageUrl to set page_url_hash="main", which the
      // assembler looks up via merge_results.get("main").
      await serverClient.uploadHtmlChunk(sessionId, html, 0, "main");
      pushToPanelSafely(sendMessage, { key: "status.htmlUploaded" });
    }

    // Start all three asset categories concurrently. Use a single
    // Promise.allSettled so a failure in one category doesn't cancel the
    // others (the finally block's uploadQueue.cancel() only runs after all
    // three settle). The main page's URL is the document URL for relative
    // URL resolution (D2 / task 1.5).
    const mainPageOptions: HandlerOptions = {
      documentUrl: tabUrl,
      failureTally: resourceFailureTally,
    };
    const imagesPromise = downloadOptions.downloadImages
      ? processImages(
          data.images,
          storage,
          tabUrl,
          sendMessage,
          context,
          mainPageOptions,
        )
      : Promise.resolve(EMPTY_MAP);

    const assetsPromise = downloadOptions.downloadAssets
      ? processAssets(
          data,
          storage,
          tabUrl,
          sendMessage,
          context,
          mainPageOptions,
        )
      : Promise.resolve(EMPTY_MAP);

    const docsPromise = downloadOptions.downloadDocuments
      ? processDocuments(
          data.documents,
          storage,
          tabUrl,
          sendMessage,
          context,
          mainPageOptions,
        )
      : Promise.resolve(EMPTY_MAP);

    // (D7 / task 1.3) The category wait gates finalization, so it carries a
    // safety bound sized from the remaining workload — the same calculus as
    // the upload drain below: 30s per resource, capped at 30 minutes. Only
    // true stalls trip it (memory-gated pauses resume via D1); on expiry the
    // stalled category is reported failed and finalization proceeds.
    const categoryResourceCount =
      data.images.length +
      data.css.length +
      data.js.length +
      data.documents.length;
    const categoryWaitBoundMs = Math.min(
      Math.max(categoryResourceCount, 1) * 30 * 1000,
      30 * 60 * 1000,
    );
    const [imagesResult, assetsResult, docsResult] = await allSettledWithBound(
      [imagesPromise, assetsPromise, docsPromise],
      categoryWaitBoundMs,
    );

    // Propagate any non-images errors after all categories have settled.
    if (assetsResult.status === "rejected") {
      console.warn(
        "[ServerMode] Asset processing failed:",
        assetsResult.reason,
      );
    }
    if (docsResult.status === "rejected") {
      console.warn(
        "[ServerMode] Document processing failed:",
        docsResult.reason,
      );
    }

    // Images are required — the filename map must be uploaded before finalization.
    if (imagesResult.status === "rejected") {
      throw imagesResult.reason;
    }
    const imageFilenameMap = imagesResult.value;

    // (Fix G) The css/js/documents handlers now return filename maps too.
    // Merge them with the image map into ONE map for upload: image entries
    // first and never overwritten, then assets, then documents (see
    // mergeFilenameMaps — sequential guarded set loops, not spread).
    const assetFilenameMap =
      assetsResult.status === "fulfilled" ? assetsResult.value : undefined;
    const docFilenameMap =
      docsResult.status === "fulfilled" ? docsResult.value : undefined;
    const fullFilenameMap = mergeFilenameMaps(
      imageFilenameMap,
      assetFilenameMap,
      docFilenameMap,
    );

    // (D7 / task 4.1) Share the main page's filename map with linked page
    // processing via the per-download context (replaces the former
    // module-global map).
    for (const [key, value] of fullFilenameMap) {
      context.imageFilenameMap.set(key, value);
    }

    // Upload filename map (needed for HTML conversion during assembly) —
    // now covering images AND stylesheets/scripts/documents, so the
    // converter resolves every reference to its exact stored path (fix G).
    if (fullFilenameMap.size > 0) {
      await serverClient.uploadFilenameMap(
        sessionId,
        Object.fromEntries(fullFilenameMap),
      );
    }

    // (Progressive checkpoint) Save resource URLs discovered so far from the
    // main page (images, assets, documents). Linked page processing below
    // may discover additional resources, but if the SW is killed during
    // linked-page scraping, this checkpoint ensures the server session is
    // recoverable. The final save after linked pages overwrites with a superset.
    const mainPageResourceUrls = uploadQueue.getResourceUrls();
    if (mainPageResourceUrls.length > 0) {
      await updateCheckpointResourceUrls(mainPageResourceUrls, sessionId);
      console.log(
        `[Checkpoint] Main page resource URLs saved: ${mainPageResourceUrls.length} entries`,
      );
    }

    // (12.5 + 12.10 + 12.11) Process linked pages with server-mode support.
    // The legacy simple-fetch mode ("downloadLinks" without full scraping)
    // was removed — crawling linked pages ALWAYS runs the in-tab
    // LinkedPageScraper now. (The legacy `downloadLinks` storage key stays
    // reserved but is ignored here.)
    if (downloadOptions.downloadLinksFullScraping && tabId) {
      pushToPanelSafely(sendMessage, { key: "status.scrapingLinkedPages" });

      const assetRegistry = new AssetRegistry();

      // Register main page assets for deduplication.
      // (D5 / tasks 3.1 + 4.1) Paths are built with the same
      // buildArchivePath(url, category) the handlers/upload paths use, so
      // registry keys equal uploaded paths.
      for (const cssUrl of data.css) {
        const fullUrl = new URL(cssUrl, tabUrl).href;
        assetRegistry.register(fullUrl, buildArchivePath(fullUrl, "styles"), 0);
      }
      for (const jsUrl of data.js) {
        const fullUrl = new URL(jsUrl, tabUrl).href;
        assetRegistry.register(
          fullUrl,
          buildArchivePath(fullUrl, "scripts"),
          0,
        );
      }
      for (const imgUrl of data.images) {
        const fullUrl = new URL(imgUrl, tabUrl).href;
        assetRegistry.register(fullUrl, buildArchivePath(fullUrl, "images"), 0);
      }
      for (const docUrl of data.documents) {
        const fullUrl = new URL(docUrl, tabUrl).href;
        assetRegistry.register(
          fullUrl,
          buildArchivePath(fullUrl, "documents"),
          0,
        );
      }

      // Create linked page scraper with server-mode flag
      const linkedPageScraper = new LinkedPageScraper(assetRegistry, {
        maxPages: downloadOptions.linkedPagesMaxCount,
        delayBetweenPages: downloadOptions.linkedPagesDelay,
        includeExternal: downloadOptions.linkedPagesIncludeExternal,
        pageTimeout: downloadOptions.linkedPagesTimeout,
        serverSessionId: sessionId,
      });

      // Guard text extraction with downloadContentAsText check
      linkedPageScraper.setExtractText(!!downloadOptions.downloadContentAsText);

      // Queue all discovered links
      setCurrentScraper(tabId, linkedPageScraper);
      for (const link of data.links) {
        try {
          const fullUrl = new URL(link, tabUrl).href;
          await linkedPageScraper.addToQueue({
            url: fullUrl,
            depth: 1,
            parentUrl: tabUrl,
            status: "queued",
          });
        } catch {
          // Ignore invalid links
        }
      }

      // Process the queue — in server mode this uploads HTML chunks
      // with pageType: "linked" and pageUrl, and uploads incremental
      // filename maps after each linked page (tasks 12.10, 12.11).
      // The per-download context carries the shared image filename map
      // (replaces the module-global map — task 4.1).
      try {
        const linkedPageText = await linkedPageScraper.processQueue(
          tabId,
          storage,
          sendMessage,
          context,
        );
        // Upload linked page text content to the server.
        // ORDERING: This must happen BEFORE the main page text upload below
        // (line ~818) because the server's uploadContent endpoint appends to
        // content.txt in file order — the linked page text delimiter format
        // assumes it follows the main page's content.
        if (linkedPageText && downloadOptions.downloadContentAsText) {
          await serverClient.uploadContent(sessionId, linkedPageText);
        }
      } finally {
        setCurrentScraper(tabId, null);
      }
    }

    // (12.7) Upload content text via uploadContent (awaited before finalization).
    // ORDERING: The server's uploadContent endpoint opens content.txt in append
    // mode, so this call adds the main page text after any linked page text
    // already uploaded above. The linked page text delimiter format
    // (\n--- URL ---\n) is designed to be appended after the main content.
    if (downloadOptions.downloadContentAsText) {
      pushToPanelSafely(sendMessage, { key: "status.downloadingContent" });
      await serverClient.uploadContent(sessionId, data.text);
      pushToPanelSafely(sendMessage, { key: "status.contentDownloaded" });
    }

    // (12.4) Send scrape-complete signal ONCE — after ALL page scrolling
    // is complete (main page + all linked pages) and every HTML chunk
    // upload has received a 200 ACK from the server. Resource uploads
    // may still be in progress at this point — the server transitions
    // to "uploading" status and accepts finalize only after all resources
    // are received, so we wait for uploads to complete before finalizing.
    //
    // The scrape-complete signal is sent BEFORE waiting for resource uploads
    // so the server can start tracking the expected resource count and
    // provide accurate progress in the UI.
    totalResourceCount = uploadQueue.getResourceCount();

    // Aggregate handler-reported failed fetches (CSS/images/js/documents).
    // resources_discovered only counts successful enqueues, so without this
    // a session with missing assets (e.g. a CSS 404) would look clean.
    const resourcesFailed = sumResourceFailures(resourceFailureTally);

    // Persist discovered resource URLs in checkpoint for resume support.
    const queueProgress = uploadQueue.getProgress();
    if (queueProgress.totalCount > 0) {
      // Collect resource URLs from the upload queue's pending + active tasks
      const resourceUrls = uploadQueue.getResourceUrls();
      if (resourceUrls.length > 0) {
        await updateCheckpointResourceUrls(resourceUrls, sessionId);
      }
    }

    pushToPanelSafely(sendMessage, { key: "status.sendingScrapeComplete" });
    await serverClient.scrapeComplete(
      sessionId,
      totalResourceCount,
      resourcesFailed,
    );
    scrapeCompleteSent = true;
    pushToPanelSafely(sendMessage, { key: "status.scrapeComplete" });
    updateCheckpointPhase("uploading", sessionId);

    // Wait for all resource uploads to complete before finalizing.
    // Finalization requires all resources to be on the server.
    pushToPanelSafely(sendMessage, { key: "status.waitingForUploads" });

    // Heartbeat: send progress every 15s so the UI can detect a dead worker.
    const heartbeatInterval = setInterval(() => {
      const progress = uploadQueue.getProgress();
      pushToPanelSafely(sendMessage, {
        key: "status.uploadProgress",
        options: {
          completed: progress.completedCount,
          total: progress.totalCount,
          bytesUploaded: progress.bytesUploaded,
          totalBytes: progress.totalBytes,
        },
      });
    }, 15000);

    try {
      const queueProgress = uploadQueue.getProgress();
      console.log(
        `[ServerMode] Waiting for uploads: ${queueProgress.completedCount}/${queueProgress.totalCount} completed, ` +
          `${queueProgress.failedCount} failed, ${uploadQueue.getResourceCount()} total resources`,
      );
      const remainingResources =
        queueProgress.totalCount - queueProgress.completedCount;
      const uploadTimeoutMs = Math.min(
        remainingResources * 30 * 1000, // 30s per remaining resource
        30 * 60 * 1000, // cap at 30 minutes
      );
      await uploadQueue.waitForAll(uploadTimeoutMs);
      // (D6) Drain completed cleanly — the finally block can skip the
      // safety-net cancel(). An abort during the wait or a timeout rejects,
      // leaving this false.
      uploadsDrainedCleanly = true;
      console.log("[ServerMode] All uploads completed");
    } catch (err) {
      // Queue may be cancelled — continue anyway, finalization
      // will proceed and the server will assemble whatever it has.
      // (stop-cancel-semantics D1 / task 2.3) A user stop cancels the
      // queue and this rejection surfaces immediately — no residual drain
      // time is awaited. The flow goes straight to finalizeSession with
      // what arrived; the polling call below then aborts at once via the
      // assembly signal (aborted by the stop listener above).
      console.warn("[ServerMode] Upload queue error:", err);
    } finally {
      clearInterval(heartbeatInterval);
    }

    // (D3) Terminal upload-failure count — propagated into the completion
    // payload so "completed with N failed uploads" is visible in the panel
    // instead of rendering as a clean success.
    const failedUploadCount = uploadQueue.getProgress().failedCount;

    // If the session size limit was reached, log and notify the user
    // that we're finalizing with partial data.
    if (uploadQueue.isSessionFull()) {
      console.log(
        "[ServerMode] Session size limit was reached. Proceeding to finalize " +
          "with partial data. Some resources were skipped.",
      );
      pushToPanelSafely(sendMessage, { key: "status.finalizingPartial" });
    }

    // (12.8) Replace ZIP generation with server finalization + polling.
    pushToPanelSafely(sendMessage, { key: "status.finalizingServer" });
    await serverClient.finalizeSession(sessionId);
    updateCheckpointPhase("assembling", sessionId);

    // Poll for assembly completion and trigger download
    // (Round 9 — Fix B) Keep the polled snapshot truthful about the phase.
    setSessionPhase(sessionId, "assembling");
    pushToPanelSafely(sendMessage, { key: "status.assemblingServer" });
    const handler = getServerDownloadHandler();

    // (12.9) Server failure handling: detect ServerUnavailableError,
    // AssemblyTimeoutError, AssemblyFailedError, and offer local fallback.
    const downloadResult = await handler.downloadWithFallback(
      sessionId,
      tabUrl,
      downloadOptions.singleFile,
      // Fallback callback — returns true if user chose an alternative (currently unused)
      async (reason, errorMessage) => {
        // UX contract: include a concrete fallback URL when the server
        // already produced one, so the panel's local-fallback action can
        // use it directly.
        const fallbackUrl = await lookupFallbackUrl(sessionId);
        pushToPanelSafely(sendMessage, {
          key: "status.serverFallbackOffer",
          options: { reason, errorMessage, fallbackUrl },
        });
        // The UI layer (task 15.5) will show a dialog. For now, we
        // send the message and return false (don't fall back automatically).
        return false;
      },
      // Assembly status callback — forward to UI for progress display.
      // (2f) The raw phase id travels in options.phase ON PURPOSE: the UI
      // translates it. server-mode-state.ts keys its assembling state
      // machine off this message key, and the service worker's i18n backend
      // loads locales asynchronously — right after an MV3 restart t() can
      // still return the key, and a pre-translated phase would also break
      // DownloadStatus's status.assemblyPhase* key lookup for non-English
      // locales. DownloadStatus and Actions render the translated label via
      // the status.assemblyPhase* keys (see en.json).
      (status, phase, progressPct, elapsedSeconds) => {
        pushToPanelSafely(sendMessage, {
          key: "status.assemblyProgress",
          options: { status, phase, progressPct, elapsedSeconds },
        });
      },
      tabId,
      downloadOptions.alwaysAskWhereToSave ?? true,
      // Per-download polling signal (task 4.2) — no shared controller.
      context.assemblyAbortController.signal,
    );

    // (stop-cancel-semantics D1 / task 2.1) A user stop NEVER terminates as
    // status.complete. This branch only covers the tiny race where the stop
    // fires after the poll returned but before the terminal sends (a stop
    // during polling surfaces as AbortError from the call above); the
    // terminal message becomes status.cancelled, with the produced archive
    // URL surfaced via the existing serverDownloadReady affordance.
    if (downloadAbort.signal.aborted) {
      if (downloadResult?.downloadUrl) {
        pushToPanelSafely(sendMessage, {
          key: "status.serverDownloadReady",
          options: {
            downloadUrl: downloadResult.downloadUrl,
            isSingleFile: downloadOptions.singleFile,
            serverSessionId: sessionId,
          },
        });
      }
      pushToPanelSafely(sendMessage, {
        key: "status.cancelled",
        options: { serverSessionId: sessionId, failedCount: failedUploadCount },
      });
      return;
    }

    // Cloud mode: server pushed to PagePocket, show cloud success
    if (downloadResult?.cloudPageId) {
      pushToPanelSafely(sendMessage, {
        key: "status.pagepocketUploadComplete",
        options: { pageId: downloadResult.cloudPageId },
      });
      // The session ID rides along so the panel's delete flow can target
      // the session after the finally block clears the active pointer.
      pushToPanelSafely(sendMessage, {
        key: "status.complete",
        options: { serverSessionId: sessionId, failedCount: failedUploadCount },
      });
    } else if (downloadResult?.cloudError) {
      // Cloud push failed — show specific error
      pushToPanelSafely(sendMessage, {
        key: "status.pagepocketUploadError",
        options: { error: downloadResult.cloudError },
      });
    } else {
      // (15.3 + 15.4) Send the server download URL to the UI so it can display
      // a "Download from server" button and show the URL in DownloadComplete.
      // Also include the URL in the status.complete message as a defensive
      // measure — the UI handler merges both, ensuring the download URL is
      // available even if serverDownloadReady was missed or reordered.
      // (D3) failedCount is additive: a clean download sends 0, which renders
      // unchanged.
      const serverCompleteOptions = {
        ...(downloadResult?.downloadUrl
          ? {
              downloadUrl: downloadResult.downloadUrl,
              isSingleFile: downloadOptions.singleFile,
            }
          : {}),
        // The session ID rides along so the panel's delete flow can target
        // the session after the finally block clears the active pointer.
        serverSessionId: sessionId,
        failedCount: failedUploadCount,
      };

      if (downloadResult?.downloadUrl) {
        pushToPanelSafely(sendMessage, {
          key: "status.serverDownloadReady",
          options: {
            downloadUrl: downloadResult.downloadUrl,
            isSingleFile: downloadOptions.singleFile,
            serverSessionId: sessionId,
          },
        });
      }

      pushToPanelSafely(sendMessage, {
        key: "status.complete",
        options: serverCompleteOptions,
      });
    }
  } catch (error) {
    // Best-effort: ensure scrapeComplete is sent so the server transitions
    // out of SCRAPING status. If the SW is killed, this won't run, but the
    // server's 30-minute stale-session cleanup is the backstop.
    if (!scrapeCompleteSent) {
      try {
        const count = uploadQueue.getResourceCount();
        await serverClient.scrapeComplete(
          sessionId,
          count,
          sumResourceFailures(resourceFailureTally),
        );
        console.log(
          "[ServerMode] Best-effort scrapeComplete sent with",
          count,
          "resources",
        );
      } catch {
        // Best effort — don't mask the original error
      }
    }

    // (12.9) Categorize server-mode errors and offer local fallback.
    const errorMessage =
      error instanceof Error ? error.message : "Unknown server error";
    const errorName = error instanceof Error ? error.name : "Unknown";
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error(
      `[ServerMode] Download failed: ${errorName}: ${errorMessage}`,
      errorStack,
    );

    // (stop-cancel-semantics D1 / tasks 2.2 + 2.4) A stop-induced AbortError
    // is user intent, not a failure — run the salvage probe (one status
    // lookup; surface the archive URL when the server already produced one)
    // and report status.cancelled instead of the generic failure branches.
    // No terminal error is recorded and nothing is rethrown, so the outer
    // catch cannot relabel the stop as status.failedWithError.
    if (isAbortError(error)) {
      console.log(
        "[ServerMode] Download cancelled by user — salvaging partial archive",
      );
      await reportCancelledSession(sessionId, sendMessage, {
        failedCount: uploadQueue.getProgress().failedCount,
      });
      return;
    }

    // (Round 9 — Fix B) Record the terminal error (includes assembly
    // timeouts/failures) so the panel's final CHECK_DOWNLOAD_LIVE poll can
    // distinguish this failure from a normal completion even when the
    // failure push was dropped by a tab switch.
    setSessionLastError(sessionId, errorMessage);

    if (
      error instanceof ServerUnavailableError ||
      error instanceof AssemblyTimeoutError ||
      error instanceof AssemblyFailedError ||
      error instanceof AuthenticationError
    ) {
      // Server-related failure — notify the user with fallback option.
      // The UI (task 15.5) will display "Retry" and "Download locally" buttons.
      // The re-scrape warning is shown when the user chooses local fallback.
      // (UX contract) A concrete fallback URL is included when the server
      // already produced a download URL for the session.
      const fallbackUrl = await lookupFallbackUrl(sessionId);
      pushToPanelSafely(sendMessage, {
        key: "status.serverError",
        options: {
          error: errorMessage,
          canFallback: true,
          fallbackUrl,
          reason:
            error instanceof ServerUnavailableError
              ? "server_unavailable"
              : error instanceof AssemblyTimeoutError
                ? "assembly_timeout"
                : error instanceof AssemblyFailedError
                  ? "assembly_failed"
                  : "auth_failed",
        },
      });
    } else {
      // Generic error — send as regular failure message
      pushToPanelSafely(sendMessage, {
        key: "status.failedWithError",
        options: { error: errorMessage },
      });
    }

    throw error;
  } finally {
    // (Fix D.1 — liveness) The download is no longer running for this
    // session — success, failure, or abort.
    markSessionNotLive(sessionId);
    // (stop-cancel-semantics D2 / task 1.5) Teardown: no poll may outlive
    // its flow — abort the assembly signal so any lingering poll loop
    // wakes immediately (no-op when it already finished or was stopped).
    context.assemblyAbortController.abort();
    // Clear the active server session so subsequent scrolling
    // doesn't try to upload to a stale session.
    setActiveServerSession(tabId!, null);
    // Cancel any remaining in-flight uploads, but do NOT delete the
    // server session. The session must remain alive so the user can
    // download the assembled ZIP/HTML from the server. The server's
    // own retention/cleanup policy (stale-session timeout) handles
    // eventual deletion.
    // (D6) Safety net only: skipped when the drain completed cleanly
    // (uploadsDrainedCleanly) — a fully successful download must not log
    // "0 active + 0 pending uploads aborted". Error/abort/timeout paths
    // still cancel here; genuine user stops also cancel via the
    // abort-listener wiring near the top of this function.
    if (!uploadsDrainedCleanly) {
      try {
        storage.getUploadQueue().cancel();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Resume a server download after service worker restart.
 *
 * Uses the checkpoint's serverSessionId to query the server for session status
 * and reconnect: re-upload resources (server deduplicates by URL hash),
 * call scrapeComplete/finalize (both idempotent), and poll for assembly.
 *
 * Falls back to throwing if the session is not recoverable (FAILED, expired, missing).
 */
/**
 * Finalize a server session and poll for assembly completion.
 * `failedCount` (D3) is the resume queue's terminal upload-failure count —
 * propagated into the status.complete payload (0 when the resume path
 * performed no local re-uploads).
 *
 * (stop-cancel-semantics D2 / task 1.2) `signal` is the caller's
 * assembly-poll signal — passed as the 8th argument to
 * downloadWithFallback so polling wakes immediately when it aborts. A
 * stop-induced AbortError is routed to the salvage step (one status probe,
 * status.cancelled — task 2.4's helper) instead of the error path; an
 * already-aborted signal never starts polling (task 3.3).
 */
async function finalizeAndPollAssembly(
  client: typeof serverClient,
  sessionId: string,
  tabUrl: string,
  tabId: number | undefined,
  saveAs: boolean,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  failedCount = 0,
  signal?: AbortSignal,
): Promise<void> {
  // (stop-cancel-semantics / task 3.3) An already-stopped resume never
  // starts polling — surface the stop as AbortError so the caller's catch
  // runs the salvage step (best-effort scrapeComplete + finalize + probe).
  if (signal?.aborted) {
    throw new DOMException("Download was cancelled", "AbortError");
  }
  pushToPanelSafely(sendMessage, { key: "status.finalizingServer" });
  try {
    await client.finalizeSession(sessionId);
  } catch {
    // May already be assembling — proceed to poll
  }

  // (Round 9 — Fix B) Keep the polled snapshot truthful about the phase.
  setSessionPhase(sessionId, "assembling");
  pushToPanelSafely(sendMessage, { key: "status.assemblingServer" });
  const handler = getServerDownloadHandler();
  let downloadResult: Awaited<ReturnType<typeof handler.downloadWithFallback>>;
  try {
    downloadResult = await handler.downloadWithFallback(
      sessionId,
      tabUrl,
      false,
      async () => false,
      (_status, phase, progressPct, elapsedSeconds) => {
        pushToPanelSafely(sendMessage, {
          key: "status.assemblyProgress",
          options: { status: "assembling", phase, progressPct, elapsedSeconds },
        });
      },
      tabId,
      saveAs,
      // Assembly-poll signal (stop-cancel-semantics D2) — aborting it wakes
      // the polling sleep immediately and rejects with AbortError.
      signal,
    );
  } catch (error) {
    if (isAbortError(error)) {
      // (stop-cancel-semantics D1 / task 1.2) Stop during assembly polling —
      // salvage: one status probe, the archive URL when the server already
      // produced one, terminal status.cancelled. Never the error path —
      // the session is already finalized above.
      console.log("[Resume] Assembly polling cancelled by user — salvaging");
      await reportCancelledSession(sessionId, sendMessage, { failedCount });
      return;
    }
    throw error;
  }

  // (stop-cancel-semantics D1 / task 2.1 parity) A user stop NEVER
  // terminates as status.complete — on the resume path either. This
  // mirrors the main path's post-poll guard: it only covers the tiny race
  // where the stop fires after the poll returned but before the terminal
  // sends (a stop during polling surfaces as AbortError from the call
  // above); the terminal message becomes status.cancelled, with the
  // already-produced archive URL surfaced via the existing
  // serverDownloadReady affordance.
  if (signal?.aborted) {
    if (downloadResult?.downloadUrl) {
      pushToPanelSafely(sendMessage, {
        key: "status.serverDownloadReady",
        options: {
          downloadUrl: downloadResult.downloadUrl,
          serverSessionId: sessionId,
        },
      });
    }
    pushToPanelSafely(sendMessage, {
      key: "status.cancelled",
      options: { serverSessionId: sessionId, failedCount },
    });
    return;
  }

  if (downloadResult?.cloudPageId) {
    pushToPanelSafely(sendMessage, {
      key: "status.pagepocketUploadComplete",
      options: { pageId: downloadResult.cloudPageId },
    });
    pushToPanelSafely(sendMessage, {
      key: "status.complete",
      options: { serverSessionId: sessionId, failedCount },
    });
  } else if (downloadResult?.cloudError) {
    pushToPanelSafely(sendMessage, {
      key: "status.pagepocketUploadError",
      options: { error: downloadResult.cloudError },
    });
  } else if (downloadResult?.downloadUrl) {
    pushToPanelSafely(sendMessage, {
      key: "status.serverDownloadReady",
      options: {
        downloadUrl: downloadResult.downloadUrl,
        serverSessionId: sessionId,
      },
    });
    pushToPanelSafely(sendMessage, {
      key: "status.complete",
      options: {
        downloadUrl: downloadResult.downloadUrl,
        serverSessionId: sessionId,
        failedCount,
      },
    });
  }
}

export async function resumeServerDownload(
  checkpoint: {
    serverSessionId?: string;
    tabUrl?: string;
    tabId?: number;
    phase?: string;
    resourceUrls?: Array<{
      url: string;
      path: string;
      contentType: string;
      size?: number;
    }>;
  },
  sendMessage: (message: string | { key: string; options?: any }) => void,
): Promise<void> {
  const { serverSessionId, tabUrl, tabId, resourceUrls } = checkpoint;

  if (!serverSessionId) {
    throw new Error("No server session ID in checkpoint");
  }

  // (Fix D.1 — liveness) A resumed download is a live download — mark the
  // session so a concurrently (re)opened panel doesn't offer Resume/Restart
  // for a download that is actually running.
  // (Round 9 — Fix B) Carry the tab + checkpoint phase into the polled
  // snapshot and clear any previous run's terminal error.
  markSessionLive(serverSessionId, {
    tabId,
    phase: checkpoint.phase ?? "uploading",
  });

  // (stop-cancel-semantics D2 / task 1.3) Per-resume assembly-poll signal —
  // aborted by the same user-stop controller that cancels the upload queue
  // (listener attached below) and on teardown, so no poll outlives this
  // resume. The resume path does not build a DownloadContext, so it owns
  // its controller.
  const resumeAssemblyAbort = new AbortController();

  // Create keepalive port and per-tab abort controller so the user
  // can press Stop to cancel a resumed download.
  let stopSignal: AbortSignal | null = null;
  if (tabId) {
    createKeepalivePort(tabId);
    const abortCtrl = new AbortController();
    setDownloadAbortController(abortCtrl, tabId);
    stopSignal = abortCtrl.signal;
    // Pressing Stop also aborts assembly polling — this listener must be
    // live before the assembling-branch poll below starts.
    abortCtrl.signal.addEventListener(
      "abort",
      () => resumeAssemblyAbort.abort(),
      { once: true },
    );
  }

  let scrapeCompleteSent = false;
  const filterOptions = await loadFilterOptions();
  const saveAs = filterOptions.alwaysAskWhereToSave ?? true;

  try {
    pushToPanelSafely(sendMessage, { key: "status.reconnectingServer" });

    // Query server for current session status
    const status = await serverClient.getSessionStatus(serverSessionId);
    console.log(
      `[Resume] Server session ${serverSessionId} status: ${status.status}`,
    );

    // If already ready, just download
    if (status.status === "ready" && status.download_url) {
      scrapeCompleteSent = true; // session already past SCRAPING
      // Self-heal a same-host http:// scheme (TLS-terminating proxy
      // misconfig — see upgradeInsecureServerUrl) before the URL reaches
      // the UI retry buttons.
      const downloadUrl = upgradeInsecureServerUrl(
        status.download_url,
        serverClient.baseUrl,
      );
      pushToPanelSafely(sendMessage, {
        key: "status.serverDownloadReady",
        options: { downloadUrl, serverSessionId },
      });
      pushToPanelSafely(sendMessage, {
        key: "status.complete",
        options: { downloadUrl, serverSessionId, failedCount: 0 },
      });
      return;
    }

    // If assembling, just poll for completion
    if (status.status === "assembling") {
      // (stop-cancel-semantics / task 3.3) An already-stopped resume never
      // starts polling — surface the stop as AbortError for the catch's
      // salvage step.
      if (stopSignal?.aborted) {
        throw new DOMException("Download was cancelled", "AbortError");
      }
      scrapeCompleteSent = true; // session already past SCRAPING
      // (Round 9 — Fix B) Keep the polled snapshot truthful.
      setSessionPhase(serverSessionId, "assembling");
      pushToPanelSafely(sendMessage, { key: "status.assemblingServer" });
      const handler = getServerDownloadHandler();
      const downloadResult = await handler.downloadWithFallback(
        serverSessionId,
        tabUrl ?? "",
        false,
        async () => false,
        (_status, phase, progressPct, elapsedSeconds) => {
          pushToPanelSafely(sendMessage, {
            key: "status.assemblyProgress",
            options: {
              status: "assembling",
              phase,
              progressPct,
              elapsedSeconds,
            },
          });
        },
        tabId,
        saveAs,
        // Assembly-poll signal (stop-cancel-semantics D2 / task 1.3) —
        // aborting the stop controller aborts this poll immediately.
        resumeAssemblyAbort.signal,
      );
      // (stop-cancel-semantics D1 / task 2.1 parity) Same post-poll race
      // guard as the main path and finalizeAndPollAssembly: a stop after
      // the poll returned but before the terminal sends still reports
      // status.cancelled (with the produced URL), never status.complete.
      if (resumeAssemblyAbort.signal.aborted) {
        if (downloadResult?.downloadUrl) {
          pushToPanelSafely(sendMessage, {
            key: "status.serverDownloadReady",
            options: {
              downloadUrl: downloadResult.downloadUrl,
              serverSessionId,
            },
          });
        }
        pushToPanelSafely(sendMessage, {
          key: "status.cancelled",
          options: { serverSessionId, failedCount: 0 },
        });
        return;
      }
      if (downloadResult?.cloudPageId) {
        pushToPanelSafely(sendMessage, {
          key: "status.pagepocketUploadComplete",
          options: { pageId: downloadResult.cloudPageId },
        });
        pushToPanelSafely(sendMessage, {
          key: "status.complete",
          options: { serverSessionId, failedCount: 0 },
        });
      } else if (downloadResult?.cloudError) {
        pushToPanelSafely(sendMessage, {
          key: "status.pagepocketUploadError",
          options: { error: downloadResult.cloudError },
        });
      } else if (downloadResult?.downloadUrl) {
        pushToPanelSafely(sendMessage, {
          key: "status.complete",
          options: {
            downloadUrl: downloadResult.downloadUrl,
            serverSessionId,
            failedCount: 0,
          },
        });
      }
      return;
    }

    // If failed or not found, can't resume
    if (status.status === "failed" || status.status === "expired") {
      throw new Error(
        `Server session is ${status.status} and cannot be resumed`,
      );
    }

    // Session is in SCRAPING or UPLOADING — resume uploads
    if (!resourceUrls || resourceUrls.length === 0) {
      // Check if the server already has resources from the interrupted session.
      // This happens when the SW was killed before the progressive checkpoint
      // save (after main-page resource processing) — all resources were uploaded
      // but scrapeComplete was never sent.
      const serverReceived = status.resources_received ?? 0;
      if (serverReceived > 0) {
        console.log(
          `[Resume] No checkpoint resource URLs, but server has ${serverReceived} resources. ` +
            `Sending scrapeComplete and proceeding to finalization.`,
        );
        pushToPanelSafely(sendMessage, { key: "status.sendingScrapeComplete" });
        await serverClient.scrapeComplete(serverSessionId, serverReceived);
        scrapeCompleteSent = true;

        // Skip re-upload — the server already has everything. Proceed to finalize.
        await finalizeAndPollAssembly(
          serverClient,
          serverSessionId,
          tabUrl ?? "",
          tabId,
          saveAs,
          sendMessage,
          0,
          // Assembly-poll signal (stop-cancel-semantics D2 / task 1.3).
          resumeAssemblyAbort.signal,
        );
        return; // Done — skip the normal upload path below
      }

      throw new Error(
        `No resource URLs in checkpoint and server has no resources ` +
          `(session=${serverSessionId}, received=${serverReceived}) — full restart required`,
      );
    }

    // Send scrape-complete FIRST when resuming from SCRAPING status
    // so the server transitions out of SCRAPING and knows the expected resource
    // count before uploads begin. For UPLOADING status this is idempotent.
    // If this fails, the outer catch block will attempt a best-effort retry.
    pushToPanelSafely(sendMessage, { key: "status.sendingScrapeComplete" });
    await serverClient.scrapeComplete(serverSessionId, resourceUrls.length);
    scrapeCompleteSent = true;

    pushToPanelSafely(sendMessage, {
      key: "status.resumingUploads",
      options: { count: resourceUrls.length },
    });

    // Create a fresh upload queue
    const uploadQueue = new UploadQueue(serverClient);
    // (Round 9 — Fix B) Expose the resume queue to CHECK_DOWNLOAD_LIVE.
    setSessionUploadQueue(serverSessionId, uploadQueue);
    uploadQueue.onProgress = (progress) => {
      pushToPanelSafely(sendMessage, {
        key: "status.uploadProgress",
        options: {
          completed: progress.completedCount,
          total: progress.totalCount,
          bytesUploaded: progress.bytesUploaded,
          totalBytes: progress.totalBytes,
        },
      });
    };

    // Wire up the per-tab abort controller so pressing Stop cancels uploads
    // AND aborts assembly polling (stop-cancel-semantics D2 / task 1.3).
    const resumeAbort = tabId ? getDownloadAbortController(tabId) : null;
    if (resumeAbort) {
      if (resumeAbort.signal.aborted) {
        uploadQueue.cancel();
        resumeAssemblyAbort.abort();
        throw new DOMException("Download was cancelled", "AbortError");
      }
      resumeAbort.signal.addEventListener(
        "abort",
        () => {
          uploadQueue.cancel();
          resumeAssemblyAbort.abort();
        },
        { once: true },
      );
    }

    // Re-fetch each resource directly by URL and enqueue for upload.
    // Uses direct fetch() instead of the content script because the
    // content script may not be available after a service worker restart.
    // (stop-cancel-semantics D2 / task 1.4) The loop observes the stop
    // signal: check before each fetch, fetch under AbortSignal.any so a
    // stop interrupts the in-flight fetch, re-check after the awaited
    // enqueue, and break on the user-abort AbortError.
    for (const entry of resourceUrls) {
      if (resumeAbort?.signal.aborted) break;
      try {
        const response = await fetch(entry.url, {
          signal: resumeAbort
            ? AbortSignal.any([resumeAbort.signal, AbortSignal.timeout(60_000)])
            : AbortSignal.timeout(60_000),
        });
        if (!response.ok) continue;
        const blob = await response.blob();
        await uploadQueue.enqueue(
          serverSessionId,
          entry.path,
          blob,
          entry.url,
          entry.contentType,
        );
        // A stop during the (awaited) enqueue must not fetch the next URL.
        if (resumeAbort?.signal.aborted) break;
      } catch (err) {
        // (stop-cancel-semantics D2 / task 1.4) NEVER swallow the
        // user-abort: an AbortError here means the stop signal fired
        // mid-fetch (the 60s timeout rejects with "TimeoutError" instead —
        // see isRetryableError in upload-queue) — break the loop and let
        // the wait/finalize below run the salvage. Individual per-resource
        // failures keep the skip-and-log behavior.
        if (isAbortError(err)) break;
        // Skip resources that can no longer be fetched
        console.warn(`[Resume] Failed to fetch resource: ${entry.url}`);
      }
    }

    // Heartbeat during uploads
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeatInterval = setInterval(() => {
        const progress = uploadQueue.getProgress();
        pushToPanelSafely(sendMessage, {
          key: "status.uploadProgress",
          options: {
            completed: progress.completedCount,
            total: progress.totalCount,
            bytesUploaded: progress.bytesUploaded,
            totalBytes: progress.totalBytes,
          },
        });
      }, 15000);

      // Wait for uploads with a timeout
      const remaining = uploadQueue.getProgress().totalCount;
      const timeoutMs = Math.min(remaining * 30 * 1000, 30 * 60 * 1000);
      await uploadQueue.waitForAll(timeoutMs);
    } catch (err) {
      // (stop-cancel-semantics D3 / tasks 3.1 + 3.2) Parity with the main
      // path: a queue timeout OR a cancel-rejection must not fail the whole
      // resume — the flow proceeds to finalize with whatever arrived. The
      // terminal status is decided downstream: a stop-induced cancellation
      // leaves the assembly signal aborted, so finalizeAndPollAssembly
      // reports status.cancelled via the salvage step; a non-stop timeout
      // keeps today's completion-with-failedCount semantics.
      console.warn(
        "[Resume] Upload wait failed — finalizing with partial data:",
        err,
      );
    } finally {
      if (heartbeatInterval !== undefined) clearInterval(heartbeatInterval);
    }

    // (D3) Terminal upload-failure count from the resume queue — surfaced in
    // the completion payload so a resumed download with failed re-uploads is
    // visible in the panel.
    const failedCount = uploadQueue.getProgress().failedCount;

    // Finalize (idempotent)
    await finalizeAndPollAssembly(
      serverClient,
      serverSessionId,
      tabUrl ?? "",
      tabId,
      saveAs,
      sendMessage,
      failedCount,
      // Assembly-poll signal (stop-cancel-semantics D2 / task 1.3) — an
      // aborted signal short-circuits at the entry check and the catch
      // below runs the salvage (tasks 3.2 + 3.4).
      resumeAssemblyAbort.signal,
    );
  } catch (error) {
    // Best-effort scrapeComplete so the server transitions out of SCRAPING.
    // Mirrors the catch-block guard in executeDownloadServerMode().
    if (!scrapeCompleteSent) {
      try {
        const count = checkpoint.resourceUrls?.length ?? 0;
        await serverClient.scrapeComplete(serverSessionId!, count);
        console.log(
          "[Resume] Best-effort scrapeComplete sent with",
          count,
          "resources",
        );
      } catch {
        // Best effort — don't mask the original error
      }
    }
    // (stop-cancel-semantics D1/D3 / tasks 3.4 + D4) An AbortError here is
    // the user pressing Stop — intent to abandon, not a resume failure.
    // Run the same salvage step as the main path: finalize the partial
    // archive (idempotent — it may already have run inside
    // finalizeAndPollAssembly), one status probe, and the cancelled
    // terminal (+ partial URL when the server already produced one).
    // Nothing is rethrown: message.ts must not wrap the stop in its
    // generic resume-failure payload, and the checkpoint clears on the
    // success path — a deliberately stopped download never resurfaces as
    // a Resume prompt.
    if (isAbortError(error)) {
      console.log(
        "[Resume] Download cancelled by user — salvaging partial archive",
      );
      try {
        await serverClient.finalizeSession(serverSessionId);
      } catch {
        // Already finalized/assembling/failed — the probe below reports.
      }
      await reportCancelledSession(serverSessionId, sendMessage);
      return;
    }
    // (Round 9 — Fix B) Record the terminal error for the panel's final
    // liveness poll (mirrors executeDownloadServerMode's catch block).
    setSessionLastError(
      serverSessionId,
      error instanceof Error ? error.message : "Unknown resume error",
    );
    throw error;
  } finally {
    // (Fix D.1 — liveness) Resume finished (or failed) — the session is no
    // longer live.
    markSessionNotLive(serverSessionId);
    // (stop-cancel-semantics D2 / task 1.5) Teardown: no poll may outlive
    // this resume — abort the assembly signal (no-op when already aborted).
    resumeAssemblyAbort.abort();
    if (tabId) {
      disconnectKeepalivePort(tabId);
      setDownloadAbortController(null, tabId);
    }
  }
}

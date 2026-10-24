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

/** Fetch timeout for non-full linked-page collection (task 3.7). Mirrors the
 * RequestQueue's default `requestTimeout` so linked-page fetches obey the
 * same bound as every other asset fetch. */
const LINKED_PAGE_FETCH_TIMEOUT_MS = 30_000;

/** Size cap for non-full linked-page HTML (task 3.7). Larger responses are
 * skipped rather than uploaded as "linked" HTML. */
const LINKED_PAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

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

export interface LinkedPageFetchResult {
  /** Links fetched and uploaded as "linked" HTML chunks. */
  uploadedCount: number;
  /** Links skipped: non-HTML, oversized, aborted, or failed. */
  skippedCount: number;
}

/**
 * Read a response body as UTF-8 text, capped at `maxBytes`.
 * Returns null when the body exceeds the cap (the stream is cancelled).
 */
async function readBoundedText(
  resp: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!resp.body) {
    const text = await resp.text();
    if (new TextEncoder().encode(text).length > maxBytes) return null;
    return text;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(combined);
}

/**
 * Fetch linked pages and upload each as a "linked" HTML chunk — bounded
 * (task 3.7). Unlike the previous bare `fetch()` + `text()` loop, this:
 *  - verifies `Content-Type` and uploads ONLY `text/html` responses
 *    (PDF/ZIP/media links count as skipped instead of becoming corrupt
 *    "HTML" documents),
 *  - enforces a size cap (default 5 MB) via Content-Length and a capped
 *    stream read,
 *  - bounds each fetch with the download's abort signal plus a per-request
 *    timeout (mirrors the RequestQueue's 30s requestTimeout).
 */
export async function fetchAndUploadLinkedPages(options: {
  links: string[];
  baseUrl: string;
  sessionId: string;
  signal?: AbortSignal;
  uploadChunk: (
    html: string,
    index: number,
    pageUrl: string,
  ) => Promise<unknown>;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<LinkedPageFetchResult> {
  const maxBytes = options.maxBytes ?? LINKED_PAGE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? LINKED_PAGE_FETCH_TIMEOUT_MS;
  let uploadedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < options.links.length; i++) {
    if (options.signal?.aborted) {
      // Download cancelled — everything left counts as skipped
      skippedCount += options.links.length - i;
      break;
    }

    let linkUrl: string;
    try {
      linkUrl = new URL(options.links[i], options.baseUrl).href;
    } catch {
      skippedCount++;
      continue;
    }

    try {
      // Composite abort: user stop + per-request timeout
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal =
        options.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([options.signal, timeoutSignal])
          : (options.signal ?? timeoutSignal);

      const resp = await fetch(linkUrl, { signal });
      const contentType = (
        resp.headers.get("content-type") ?? ""
      ).toLowerCase();

      if (!resp.ok || !contentType.includes("text/html")) {
        skippedCount++;
        continue;
      }

      // Cheap Content-Length check before reading the body
      const contentLength = parseInt(
        resp.headers.get("content-length") ?? "",
        10,
      );
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        skippedCount++;
        continue;
      }

      const html = await readBoundedText(resp, maxBytes);
      if (html === null) {
        // Body exceeded the cap mid-stream
        skippedCount++;
        continue;
      }

      await options.uploadChunk(html, i, linkUrl);
      uploadedCount++;
    } catch {
      // Skip failed linked pages (network error, timeout, or abort)
      skippedCount++;
    }
  }

  return { uploadedCount, skippedCount };
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
    sendMessage({ key: "app.noUrl" });
    return;
  }

  // Prevent concurrent downloads per-tab
  if (tabId && isTabDownloadInProgress(tabId)) {
    sendMessage({ key: "app.downloadInProgress" });
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
    sendMessage({ key: "app.memoryPressure" });
    return;
  }
  if (availableMemoryMB < 256) {
    sendMessage({
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

    let userFriendlyMessage: string | { key: string; options?: any } = {
      key: "status.failedWithError",
      options: { error: errorMessage },
    };
    let isMemoryError = false;

    if (error instanceof PanelUnavailableError) {
      userFriendlyMessage = { key: "app.panelUnavailable" };
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

    sendMessage(userFriendlyMessage);

    if (isMemoryError) {
      // forceCleanup runs the registered cleanup callbacks, which clear the
      // SHARED request queue — while another download is active that would
      // destroy its in-flight/queued state. Its own teardown will run the
      // global cleanup once it is the last download.
      if (!isOtherDownloadActive(tabId)) {
        await memoryManager.forceCleanup();
      }
      sendMessage({ key: "status.memoryCleanupPerformed" });
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

  // Link the download-level abort controller to the upload queue
  // so that pressing Stop aborts in-flight uploads.
  const downloadAbort = context.abortController;
  {
    // If already aborted before we start, exit immediately
    if (downloadAbort.signal.aborted) {
      throw new DOMException("Download was cancelled", "AbortError");
    }
    // When the download-level controller aborts, also cancel the upload queue
    downloadAbort.signal.addEventListener(
      "abort",
      () => {
        uploadQueue.cancel();
      },
      { once: true },
    );
  }

  // (15.1) Wire up upload progress reporting so the UI can show
  // "X/Y resources uploaded" during the server-mode download.
  uploadQueue.onProgress = (progress) => {
    sendMessage({
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
    sendMessage({ key: "status.sessionSizeLimitReached" });
  };

  // Track total resources for scrape-complete signal
  let totalResourceCount = 0;
  let scrapeCompleteSent = false;

  try {
    // (12.3) Upload main page HTML as chunk to the server.
    // scrollIndex 0 = first (and possibly only) chunk for the main page.
    //
    // (13.3) Skip this upload if HTML chunks were already streamed to the
    // server during scrolling (via SCROLL_AND_EXTRACT_DIFF or
    // SERVER_UPLOAD_HTML_CHUNK). This prevents double-uploading and
    // avoids sending an empty/placeholder HTML string.
    if (!hasStreamedHtmlChunks(tabId!)) {
      sendMessage({ key: "status.uploadingHtml" });
      // Do NOT send tabUrl as pageUrl for main page — the server uses
      // the absence of pageUrl to set page_url_hash="main", which the
      // assembler looks up via merge_results.get("main").
      await serverClient.uploadHtmlChunk(sessionId, html, 0, "main");
      sendMessage({ key: "status.htmlUploaded" });
    }

    // Extract resources from the HTML
    const data = getResources(html);

    // Start all three asset categories concurrently. Use a single
    // Promise.allSettled so a failure in one category doesn't cancel the
    // others (the finally block's uploadQueue.cancel() only runs after all
    // three settle). The main page's URL is the document URL for relative
    // URL resolution (D2 / task 1.5).
    const mainPageOptions: HandlerOptions = { documentUrl: tabUrl };
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

    const [imagesResult, assetsResult, docsResult] = await Promise.allSettled([
      imagesPromise,
      assetsPromise,
      docsPromise,
    ]);

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
    if (downloadOptions.downloadLinks) {
      if (downloadOptions.downloadLinksFullScraping && tabId) {
        sendMessage({ key: "status.scrapingLinkedPages" });

        const assetRegistry = new AssetRegistry();

        // Register main page assets for deduplication.
        // (D5 / tasks 3.1 + 4.1) Paths are built with the same
        // buildArchivePath(url, category) the handlers/upload paths use, so
        // registry keys equal uploaded paths.
        for (const cssUrl of data.css) {
          const fullUrl = new URL(cssUrl, tabUrl).href;
          assetRegistry.register(
            fullUrl,
            buildArchivePath(fullUrl, "styles"),
            0,
          );
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
          assetRegistry.register(
            fullUrl,
            buildArchivePath(fullUrl, "images"),
            0,
          );
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
        linkedPageScraper.setExtractText(
          !!downloadOptions.downloadContentAsText,
        );

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
      } else {
        // Non-full-scraping: fetch linked pages and upload to server,
        // bounded by content-type, size cap, and timeout (task 3.7).
        sendMessage({
          key: "status.downloadingLinks",
          options: { count: data.links.length },
        });
        const { uploadedCount, skippedCount } = await fetchAndUploadLinkedPages(
          {
            links: data.links,
            baseUrl: tabUrl,
            sessionId,
            signal: context.abortController.signal,
            uploadChunk: (html, index, pageUrl) =>
              serverClient.uploadHtmlChunk(
                sessionId,
                html,
                index,
                "linked",
                pageUrl,
              ),
          },
        );
        console.log(
          `[ServerMode] Linked pages: ${uploadedCount} uploaded as HTML, ` +
            `${skippedCount} skipped (non-HTML, oversized, or failed)`,
        );
        sendMessage({ key: "status.linksDownloaded" });
      }
    }

    // (12.7) Upload content text via uploadContent (awaited before finalization).
    // ORDERING: The server's uploadContent endpoint opens content.txt in append
    // mode, so this call adds the main page text after any linked page text
    // already uploaded above. The linked page text delimiter format
    // (\n--- URL ---\n) is designed to be appended after the main content.
    if (downloadOptions.downloadContentAsText) {
      sendMessage({ key: "status.downloadingContent" });
      await serverClient.uploadContent(sessionId, data.text);
      sendMessage({ key: "status.contentDownloaded" });
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

    // Persist discovered resource URLs in checkpoint for resume support.
    const queueProgress = uploadQueue.getProgress();
    if (queueProgress.totalCount > 0) {
      // Collect resource URLs from the upload queue's pending + active tasks
      const resourceUrls = uploadQueue.getResourceUrls();
      if (resourceUrls.length > 0) {
        await updateCheckpointResourceUrls(resourceUrls, sessionId);
      }
    }

    sendMessage({ key: "status.sendingScrapeComplete" });
    await serverClient.scrapeComplete(sessionId, totalResourceCount);
    scrapeCompleteSent = true;
    sendMessage({ key: "status.scrapeComplete" });
    updateCheckpointPhase("uploading", sessionId);

    // Wait for all resource uploads to complete before finalizing.
    // Finalization requires all resources to be on the server.
    sendMessage({ key: "status.waitingForUploads" });

    // Heartbeat: send progress every 15s so the UI can detect a dead worker.
    const heartbeatInterval = setInterval(() => {
      const progress = uploadQueue.getProgress();
      sendMessage({
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
      console.log("[ServerMode] All uploads completed");
    } catch (err) {
      // Queue may be cancelled — continue anyway, finalization
      // will proceed and the server will assemble whatever it has.
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
      sendMessage({ key: "status.finalizingPartial" });
    }

    // (12.8) Replace ZIP generation with server finalization + polling.
    sendMessage({ key: "status.finalizingServer" });
    await serverClient.finalizeSession(sessionId);
    updateCheckpointPhase("assembling", sessionId);

    // Poll for assembly completion and trigger download
    sendMessage({ key: "status.assemblingServer" });
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
        sendMessage({
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
        sendMessage({
          key: "status.assemblyProgress",
          options: { status, phase, progressPct, elapsedSeconds },
        });
      },
      tabId,
      downloadOptions.alwaysAskWhereToSave ?? true,
      // Per-download polling signal (task 4.2) — no shared controller.
      context.assemblyAbortController.signal,
    );

    // Cloud mode: server pushed to PagePocket, show cloud success
    if (downloadResult?.cloudPageId) {
      sendMessage({
        key: "status.pagepocketUploadComplete",
        options: { pageId: downloadResult.cloudPageId },
      });
      // The session ID rides along so the panel's delete flow can target
      // the session after the finally block clears the active pointer.
      sendMessage({
        key: "status.complete",
        options: { serverSessionId: sessionId, failedCount: failedUploadCount },
      });
    } else if (downloadResult?.cloudError) {
      // Cloud push failed — show specific error
      sendMessage({
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
        sendMessage({
          key: "status.serverDownloadReady",
          options: {
            downloadUrl: downloadResult.downloadUrl,
            isSingleFile: downloadOptions.singleFile,
            serverSessionId: sessionId,
          },
        });
      }

      sendMessage({ key: "status.complete", options: serverCompleteOptions });
    }
  } catch (error) {
    // Best-effort: ensure scrapeComplete is sent so the server transitions
    // out of SCRAPING status. If the SW is killed, this won't run, but the
    // server's 30-minute stale-session cleanup is the backstop.
    if (!scrapeCompleteSent) {
      try {
        const count = uploadQueue.getResourceCount();
        await serverClient.scrapeComplete(sessionId, count);
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
      sendMessage({
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
      sendMessage({
        key: "status.failedWithError",
        options: { error: errorMessage },
      });
    }

    throw error;
  } finally {
    // Clear the active server session so subsequent scrolling
    // doesn't try to upload to a stale session.
    setActiveServerSession(tabId!, null);
    // Cancel any remaining in-flight uploads, but do NOT delete the
    // server session. The session must remain alive so the user can
    // download the assembled ZIP/HTML from the server. The server's
    // own retention/cleanup policy (stale-session timeout) handles
    // eventual deletion.
    try {
      storage.getUploadQueue().cancel();
    } catch {
      // Ignore cleanup errors
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
 */
async function finalizeAndPollAssembly(
  client: typeof serverClient,
  sessionId: string,
  tabUrl: string,
  tabId: number | undefined,
  saveAs: boolean,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  failedCount = 0,
): Promise<void> {
  sendMessage({ key: "status.finalizingServer" });
  try {
    await client.finalizeSession(sessionId);
  } catch {
    // May already be assembling — proceed to poll
  }

  sendMessage({ key: "status.assemblingServer" });
  const handler = getServerDownloadHandler();
  const downloadResult = await handler.downloadWithFallback(
    sessionId,
    tabUrl,
    false,
    async () => false,
    (_status, phase, progressPct, elapsedSeconds) => {
      sendMessage({
        key: "status.assemblyProgress",
        options: { status: "assembling", phase, progressPct, elapsedSeconds },
      });
    },
    tabId,
    saveAs,
  );

  if (downloadResult?.cloudPageId) {
    sendMessage({
      key: "status.pagepocketUploadComplete",
      options: { pageId: downloadResult.cloudPageId },
    });
    sendMessage({
      key: "status.complete",
      options: { serverSessionId: sessionId, failedCount },
    });
  } else if (downloadResult?.cloudError) {
    sendMessage({
      key: "status.pagepocketUploadError",
      options: { error: downloadResult.cloudError },
    });
  } else if (downloadResult?.downloadUrl) {
    sendMessage({
      key: "status.serverDownloadReady",
      options: {
        downloadUrl: downloadResult.downloadUrl,
        serverSessionId: sessionId,
      },
    });
    sendMessage({
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

  // Create keepalive port and per-tab abort controller so the user
  // can press Stop to cancel a resumed download.
  if (tabId) {
    createKeepalivePort(tabId);
    const abortCtrl = new AbortController();
    setDownloadAbortController(abortCtrl, tabId);
  }

  let scrapeCompleteSent = false;
  const filterOptions = await loadFilterOptions();
  const saveAs = filterOptions.alwaysAskWhereToSave ?? true;

  try {
    sendMessage({ key: "status.reconnectingServer" });

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
      sendMessage({
        key: "status.serverDownloadReady",
        options: { downloadUrl, serverSessionId },
      });
      sendMessage({
        key: "status.complete",
        options: { downloadUrl, serverSessionId, failedCount: 0 },
      });
      return;
    }

    // If assembling, just poll for completion
    if (status.status === "assembling") {
      scrapeCompleteSent = true; // session already past SCRAPING
      sendMessage({ key: "status.assemblingServer" });
      const handler = getServerDownloadHandler();
      const downloadResult = await handler.downloadWithFallback(
        serverSessionId,
        tabUrl ?? "",
        false,
        async () => false,
        (_status, phase, progressPct, elapsedSeconds) => {
          sendMessage({
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
      );
      if (downloadResult?.cloudPageId) {
        sendMessage({
          key: "status.pagepocketUploadComplete",
          options: { pageId: downloadResult.cloudPageId },
        });
        sendMessage({
          key: "status.complete",
          options: { serverSessionId, failedCount: 0 },
        });
      } else if (downloadResult?.cloudError) {
        sendMessage({
          key: "status.pagepocketUploadError",
          options: { error: downloadResult.cloudError },
        });
      } else if (downloadResult?.downloadUrl) {
        sendMessage({
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
        sendMessage({ key: "status.sendingScrapeComplete" });
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
    sendMessage({ key: "status.sendingScrapeComplete" });
    await serverClient.scrapeComplete(serverSessionId, resourceUrls.length);
    scrapeCompleteSent = true;

    sendMessage({
      key: "status.resumingUploads",
      options: { count: resourceUrls.length },
    });

    // Create a fresh upload queue
    const uploadQueue = new UploadQueue(serverClient);
    uploadQueue.onProgress = (progress) => {
      sendMessage({
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
    const resumeAbort = tabId ? getDownloadAbortController(tabId) : null;
    if (resumeAbort) {
      if (resumeAbort.signal.aborted) {
        uploadQueue.cancel();
        throw new DOMException("Download was cancelled", "AbortError");
      }
      resumeAbort.signal.addEventListener("abort", () => uploadQueue.cancel(), {
        once: true,
      });
    }

    // Re-fetch each resource directly by URL and enqueue for upload.
    // Uses direct fetch() instead of the content script because the
    // content script may not be available after a service worker restart.
    for (const entry of resourceUrls) {
      try {
        const response = await fetch(entry.url, {
          signal: AbortSignal.timeout(60_000),
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
      } catch {
        // Skip resources that can no longer be fetched
        console.warn(`[Resume] Failed to fetch resource: ${entry.url}`);
      }
    }

    // Heartbeat during uploads
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeatInterval = setInterval(() => {
        const progress = uploadQueue.getProgress();
        sendMessage({
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
    throw error;
  } finally {
    if (tabId) {
      disconnectKeepalivePort(tabId);
      setDownloadAbortController(null, tabId);
    }
  }
}

import { getResources } from "./resources";
import { memoryManager } from "../utils/MemoryManager";
import { requestQueue } from "../utils/RequestQueue";
import { cleanupAfterDownload } from "./cleanupHandlers";
import { FilterOptions } from "../types/filterTypes";
import {
  downloadId,
  setTabDownloadActive,
  setTabDownloadComplete,
  isTabDownloadInProgress,
  setDownloadAbortController,
  getDownloadAbortController,
  createKeepalivePort,
  disconnectKeepalivePort,
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
  processAssets,
  processDocuments,
  processImages,
} from "./download-processors";
import { AssetRegistry } from "./asset-registry";
import {
  LinkedPageScraper,
  setGlobalImageFilenameMap,
} from "./linked-page-scraper";
import { fixFilename } from "./urlUtils";
import { ServerStorageAdapter } from "./storage/server-storage-adapter";
import {
  serverClient,
  ServerUnavailableError,
  AuthenticationError,
  AssemblyTimeoutError,
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

const EMPTY_MAP: Map<string, string> = new Map();

/**
 * Get the PagePocket user ID when cloud mode is enabled.
 *
 * Returns the user ID when ALL of the following hold:
 *  1. The PagePocket cloud toggle is ON (chrome.storage.local)
 *  2. Valid auth tokens exist in chrome.storage.local
 *
 * Returns null otherwise — the server will create a normal (non-cloud) session.
 */
async function getPagepocketUserId(): Promise<string | null> {
  try {
    if (!chrome?.storage?.local) return null;
    const result = await chrome.storage.local.get([
      PAGEPOCKET_CLOUD_ENABLED_KEY,
      PAGEPOCKET_AUTH_STORAGE_KEY,
    ]);
    const cloudEnabled = result[PAGEPOCKET_CLOUD_ENABLED_KEY] === true;
    const auth = result[PAGEPOCKET_AUTH_STORAGE_KEY] as
      | PagePocketAuthState
      | undefined;
    if (cloudEnabled && auth?.accessToken && auth?.user?.id) {
      return auth.user.id;
    }
    return null;
  } catch {
    return null;
  }
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
    sendMessage({ key: "error.noUrl" });
    return;
  }

  // Prevent concurrent downloads per-tab
  if (tabId && isTabDownloadInProgress(tabId)) {
    sendMessage({ key: "error.downloadInProgress" });
    return;
  }

  // Memory check — server mode threshold (100MB available)
  const initialMemoryStats = memoryManager.getMemoryStats();
  const availableMemoryBytes =
    initialMemoryStats.totalMemoryLimit - initialMemoryStats.totalMemoryUsed;
  const availableMemoryMB = availableMemoryBytes / (1024 * 1024);
  if (availableMemoryMB < 100) {
    sendMessage({ key: "error.memoryPressure" });
    return;
  }
  if (availableMemoryMB < 256) {
    sendMessage({
      key: "status.memoryWarningServerMode",
      options: { availableMB: Math.round(availableMemoryMB) },
    });
  }

  await setTabDownloadActive(tabId!);

  try {
    createKeepalivePort(tabId!);

    // Read PagePocket cloud user ID if cloud mode is enabled.
    // When set, the server will push the assembled result to PagePocket
    // instead of creating a ZIP file.
    const pagepocketUserId = await getPagepocketUserId();

    // Create server session (reuse existing if created during INITIALIZE_DIFFERENTIAL_SCRAPING)
    const existingSessionId = getActiveServerSessionId(tabId!);
    let serverSessionId: string;
    if (existingSessionId) {
      serverSessionId = existingSessionId;
    } else {
      serverSessionId = await serverClient.createSession(tabUrl, {
        singleFile: downloadOptions?.singleFile ?? false,
        retentionDays: 1,
        pagepocketUserId: pagepocketUserId ?? undefined,
      });
      setActiveServerSession(tabId!, serverSessionId);
    }

    const storage = new ServerStorageAdapter(serverClient);
    storage.setSessionId(serverSessionId);

    // Write interrupt checkpoint
    await writeCheckpoint({
      phase: "scraping",
      serverSessionId,
      tabId,
      tabUrl,
    });

    // Create abort controller for this download session
    const downloadAbort = new AbortController();
    setDownloadAbortController(downloadAbort, tabId!);

    await performInitialCleanup();
    await executeDownloadServerMode(
      html,
      tabUrl,
      downloadOptions,
      sendMessage,
      storage,
      serverSessionId,
      tabId,
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
      await memoryManager.forceCleanup();
      sendMessage({ key: "status.memoryCleanupPerformed" });
    }
  } finally {
    await setTabDownloadComplete(tabId!);
    setDownloadAbortController(null, tabId!);
    disconnectKeepalivePort(tabId!);
    await clearCheckpoint();

    try {
      await cleanupAfterDownload(downloadId);
      await requestQueue.clear();
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
  tabId?: number,
): Promise<void> {
  const uploadQueue = storage.getUploadQueue();

  // Link the download-level abort controller to the upload queue
  // so that pressing Stop aborts in-flight uploads.
  const downloadAbort = getDownloadAbortController(tabId!);
  if (downloadAbort) {
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
    // three settle).
    const imagesPromise = downloadOptions.downloadImages
      ? processImages(data.images, storage, tabUrl, sendMessage)
      : Promise.resolve(EMPTY_MAP);

    const assetsPromise = downloadOptions.downloadAssets
      ? processAssets(data, storage, tabUrl, sendMessage)
      : Promise.resolve();

    const docsPromise = downloadOptions.downloadDocuments
      ? processDocuments(data.documents, storage, tabUrl, sendMessage)
      : Promise.resolve();

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

    // Upload filename map (needed for HTML conversion during assembly).
    if (imageFilenameMap.size > 0) {
      await serverClient.uploadFilenameMap(
        sessionId,
        Object.fromEntries(imageFilenameMap),
      );
    }

    // (Progressive checkpoint) Save resource URLs discovered so far from the
    // main page (images, assets, documents). Linked page processing below
    // may discover additional resources, but if the SW is killed during
    // linked-page scraping, this checkpoint ensures the server session is
    // recoverable. The final save after linked pages overwrites with a superset.
    const mainPageResourceUrls = uploadQueue.getResourceUrls();
    if (mainPageResourceUrls.length > 0) {
      await updateCheckpointResourceUrls(mainPageResourceUrls);
      console.log(
        `[Checkpoint] Main page resource URLs saved: ${mainPageResourceUrls.length} entries`,
      );
    }

    // (12.5 + 12.10 + 12.11) Process linked pages with server-mode support.
    if (downloadOptions.downloadLinks) {
      if (downloadOptions.downloadLinksFullScraping && tabId) {
        sendMessage({ key: "status.scrapingLinkedPages" });

        const assetRegistry = new AssetRegistry();

        // Register main page assets for deduplication
        for (const cssUrl of data.css) {
          const fullUrl = new URL(cssUrl, tabUrl).href;
          assetRegistry.register(fullUrl, `styles/${fixFilename(cssUrl)}`, 0);
        }
        for (const jsUrl of data.js) {
          const fullUrl = new URL(jsUrl, tabUrl).href;
          assetRegistry.register(fullUrl, `scripts/${fixFilename(jsUrl)}`, 0);
        }
        for (const imgUrl of data.images) {
          const fullUrl = new URL(imgUrl, tabUrl).href;
          assetRegistry.register(fullUrl, `images/${fixFilename(imgUrl)}`, 0);
        }
        for (const docUrl of data.documents) {
          const fullUrl = new URL(docUrl, tabUrl).href;
          assetRegistry.register(
            fullUrl,
            `documents/${fixFilename(docUrl)}`,
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

        // Share main page image filename map
        setGlobalImageFilenameMap(imageFilenameMap);

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
        try {
          const linkedPageText = await linkedPageScraper.processQueue(
            tabId,
            storage,
            sendMessage,
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
        // Non-full-scraping: fetch linked pages and upload to server
        sendMessage({
          key: "status.downloadingLinks",
          options: { count: data.links.length },
        });
        for (let i = 0; i < data.links.length; i++) {
          try {
            const linkUrl = new URL(data.links[i], tabUrl).href;
            const resp = await fetch(linkUrl, {
              signal: getDownloadAbortController(tabId!)?.signal,
            });
            const linkHtml = await resp.text();
            await serverClient.uploadHtmlChunk(
              sessionId,
              linkHtml,
              i,
              "linked",
              linkUrl,
            );
          } catch {
            // skip failed linked pages
          }
        }
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
        await updateCheckpointResourceUrls(resourceUrls);
      }
    }

    sendMessage({ key: "status.sendingScrapeComplete" });
    await serverClient.scrapeComplete(sessionId, totalResourceCount);
    scrapeCompleteSent = true;
    sendMessage({ key: "status.scrapeComplete" });
    updateCheckpointPhase("uploading");

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
    updateCheckpointPhase("assembling");

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
        sendMessage({
          key: "status.serverFallbackOffer",
          options: { reason, errorMessage },
        });
        // The UI layer (task 15.5) will show a dialog. For now, we
        // send the message and return false (don't fall back automatically).
        return false;
      },
      // Assembly status callback — forward to UI for progress display
      (status, phase, progressPct) => {
        sendMessage({
          key: "status.assemblyProgress",
          options: { status, phase, progressPct },
        });
      },
      tabId,
      downloadOptions.alwaysAskWhereToSave ?? true,
    );

    // Cloud mode: server pushed to PagePocket, show cloud success
    if (downloadResult?.cloudPageId) {
      sendMessage({
        key: "status.pagepocketUploadComplete",
        options: { pageId: downloadResult.cloudPageId },
      });
      sendMessage({ key: "status.complete" });
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
      const serverCompleteOptions = downloadResult?.downloadUrl
        ? {
            downloadUrl: downloadResult.downloadUrl,
            isSingleFile: downloadOptions.singleFile,
          }
        : undefined;

      if (downloadResult?.downloadUrl) {
        sendMessage({
          key: "status.serverDownloadReady",
          options: {
            downloadUrl: downloadResult.downloadUrl,
            isSingleFile: downloadOptions.singleFile,
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
      sendMessage({
        key: "status.serverError",
        options: {
          error: errorMessage,
          canFallback: true,
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
/** Finalize a server session and poll for assembly completion. */
async function finalizeAndPollAssembly(
  client: typeof serverClient,
  sessionId: string,
  tabUrl: string,
  tabId: number | undefined,
  saveAs: boolean,
  sendMessage: (message: string | { key: string; options?: any }) => void,
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
    (_status, phase, progressPct) => {
      sendMessage({
        key: "status.assemblyProgress",
        options: { status: "assembling", phase, progressPct },
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
    sendMessage({ key: "status.complete" });
  } else if (downloadResult?.cloudError) {
    sendMessage({
      key: "status.pagepocketUploadError",
      options: { error: downloadResult.cloudError },
    });
  } else if (downloadResult?.downloadUrl) {
    sendMessage({
      key: "status.serverDownloadReady",
      options: { downloadUrl: downloadResult.downloadUrl },
    });
    sendMessage({
      key: "status.complete",
      options: { downloadUrl: downloadResult.downloadUrl },
    });
  }
}

export async function resumeServerDownload(
  checkpoint: {
    serverSessionId?: string;
    tabUrl?: string;
    tabId?: number;
    phase?: string;
    resourceUrls?: Array<{ url: string; path: string; contentType: string }>;
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
      sendMessage({
        key: "status.serverDownloadReady",
        options: { downloadUrl: status.download_url },
      });
      sendMessage({
        key: "status.complete",
        options: { downloadUrl: status.download_url },
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
        (_status, phase, progressPct) => {
          sendMessage({
            key: "status.assemblyProgress",
            options: { status: "assembling", phase, progressPct },
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
        sendMessage({ key: "status.complete" });
      } else if (downloadResult?.cloudError) {
        sendMessage({
          key: "status.pagepocketUploadError",
          options: { error: downloadResult.cloudError },
        });
      } else if (downloadResult?.downloadUrl) {
        sendMessage({
          key: "status.complete",
          options: { downloadUrl: downloadResult.downloadUrl },
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

    // Finalize (idempotent)
    await finalizeAndPollAssembly(
      serverClient,
      serverSessionId,
      tabUrl ?? "",
      tabId,
      saveAs,
      sendMessage,
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

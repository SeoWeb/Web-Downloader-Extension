
import JSZip from "jszip";
import { getResources } from "./resources";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";
import { requestQueue } from "../utils/RequestQueue";
import { addIndexHtml } from "./fileHandlers";
import { cleanupAfterDownload } from "./cleanupHandlers";
import { finalizeIncrementalMerge } from "./merge-html";
import { FilterOptions } from "../types/filterTypes";
import { downloadId, setDownloadInProgress, getDownloadInProgress, setDownloadAbortController, getDownloadAbortController, createKeepalivePort, disconnectKeepalivePort } from "./download-state";
import { writeCheckpoint, updateCheckpointPhase, clearCheckpoint } from "./download-checkpoint";
import { initiateDownload, performInitialCleanup } from "./download-utils";
import { isPanelAlive, downloadViaPanelAndWait, PanelUnavailableError } from "./panel-download";
import { 
  processRegularHtml, 
  processAssets, 
  processDocuments, 
  processImages, 
  processLinks, 
  addIndexHtmlFromBlob 
} from "./download-processors";
import { addContentText } from "./fileHandlers";
import { AssetRegistry } from "./asset-registry";
import { LinkedPageScraper, setGlobalImageFilenameMap } from "./linked-page-scraper";
import { convertToSingleFileHtml } from "./html-utils/html-converter";
import { fixFilename } from "./urlUtils";
import { SplitZipGenerator } from "./zip-stream-splitter";

// IndexedDB Storage imports
import { IStorageAdapter, JSZipAdapter, IndexedDBAdapter } from "./storage/storage-adapter";
import { ServerStorageAdapter } from "./storage/server-storage-adapter";
import { serverClient, ServerUnavailableError, AuthenticationError, AssemblyTimeoutError } from "./server-client";
import { SessionManager } from "./storage/session-manager";
import { FileStore } from "./storage/file-store";
import { getServerDownloadHandler, AssemblyFailedError } from "./server-download";

// Configuration
const USE_INDEXEDDB = true; // Feature flag for IndexedDB mode

// Server mode is determined at build time by VITE_SERVER_URL.
// When set, ServerStorageAdapter is used and server-side assembly replaces local ZIP generation.
import { IS_SERVER_MODE } from "../common/server-mode";

// Runtime flag to force local mode for the current download (used by
// SERVER_LOCAL_FALLBACK message handler — task 13.2). When true,
// all IS_SERVER_MODE checks are bypassed and the download uses the
// local IndexedDB/JSZip pipeline regardless of VITE_SERVER_URL.
//
// Scoped as a module-level variable because the force-local decision
// must be available to shouldUseServerMode() which is called from
// selectStorageAdapter() and other helpers inside downloadResources().
// The concurrency guard (getDownloadInProgress) prevents overlapping
// downloads, so there is no risk of the flag leaking between concurrent
// downloads. The flag is always reset at the start of downloadResources().
let forceLocalMode = false;

/** Set the force-local-mode flag for the next download. */
export function setForceLocalMode(value: boolean): void {
  forceLocalMode = value;
}

/** Check if the current download should use server mode.
 *  Returns false if forceLocalMode is set, otherwise follows IS_SERVER_MODE.
 *  Exported for testability — production code should prefer the
 *  IS_SERVER_MODE import from server-mode.ts for static checks. */
export function shouldUseServerMode(): boolean {
  return IS_SERVER_MODE && !forceLocalMode;
}

import { setCurrentScraper } from "./scraper-state";
import { setActiveServerSession, getActiveServerSessionId, hasStreamedHtmlChunks } from "./message";

// ... (other imports remain, but we need to remove the local exports below)

/**
 * Enhanced download function with streaming support for large files
 */
export async function downloadResources(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  assemblyJobId?: string, // Optional job ID for incremental assembly
  tabId?: number, // Tab ID for tracking downloads
) {
  if (!tabUrl) {
    sendMessage({ key: "error.noUrl" });
    return;
  }

  // Prevent concurrent downloads
  if (await getDownloadInProgress()) {
    sendMessage({ key: "error.downloadInProgress" });
    return;
  }

  // Reset force-local flag at the start of each download, then check
  // if the caller requested local mode via _forceLocal option.
  forceLocalMode = false;
  if (downloadOptions?._forceLocal) {
    forceLocalMode = true;
  }

  // Initial memory check and cleanup
  // (S1) In server mode the memory rejection threshold is lower (100MB available)
  // because ZIP assembly and HTML merging are offloaded to the server.
  // In local mode the standard CRITICAL threshold applies (256MB available).
  const initialMemoryStats = memoryManager.getMemoryStats();
  const availableMemoryBytes = initialMemoryStats.totalMemoryLimit - initialMemoryStats.totalMemoryUsed;
  const availableMemoryMB = availableMemoryBytes / (1024 * 1024);

  if (shouldUseServerMode()) {
    // Server mode: reject if < 100MB available (resources still need to be
    // held in memory before upload, but ZIP assembly is server-side)
    if (availableMemoryMB < 100) {
      sendMessage({ key: "error.memoryPressure" });
      return;
    }
    // Non-blocking warning when available memory is between 100-256MB
    if (availableMemoryMB < 256) {
      sendMessage({ key: "status.memoryWarningServerMode", options: { availableMB: Math.round(availableMemoryMB) } });
    }
  } else {
    // Local mode: use the standard CRITICAL pressure level
    if (initialMemoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL) {
      sendMessage({ key: "error.memoryPressure" });
      return;
    }
  }

  await setDownloadInProgress(true);

  // Create keepalive port to prevent Chrome from killing the service worker
  // during the download lifecycle (scraping, uploading, packing).
  createKeepalivePort();

  // Write interrupt checkpoint so we can detect/recover if the SW is killed.
  writeCheckpoint({
    phase: "scraping",
    serverSessionId: shouldUseServerMode() ? getActiveServerSessionId() ?? undefined : undefined,
    tabId,
    tabUrl,
  });

  // Create abort controller for this download session so the user
  // can press Stop and cancel all in-progress uploads and the download flow.
  const downloadAbort = new AbortController();
  setDownloadAbortController(downloadAbort);

  try {
    // Perform initial cleanup
    await performInitialCleanup();

    // Execute the download within a try-catch-finally block
    await executeDownload(html, tabUrl, downloadOptions, sendMessage, assemblyJobId, tabId);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    
    // Categorize error for better user feedback
    let userFriendlyMessage: string | { key: string; options?: any } = { key: "status.failedWithError", options: { error: errorMessage } };
    let isMemoryError = false;

    if (error instanceof PanelUnavailableError) {
      // Panel was closed or unavailable — already sent the app.panelUnavailable message
      // from the inner catch, so just use a short error here
      userFriendlyMessage = { key: "app.panelUnavailable" };
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

    // If it's a memory-related error, perform cleanup
    if (isMemoryError) {
      await memoryManager.forceCleanup();
      sendMessage({ key: "status.memoryCleanupPerformed" });
    }
  } finally {
    // Always reset the flag when done and cleanup
    await setDownloadInProgress(false);
    setDownloadAbortController(null);
    disconnectKeepalivePort();
    await clearCheckpoint();

    // Cleanup download-specific resources
    try {
      await cleanupAfterDownload(downloadId);

      // Clear the queue after download completion
      await requestQueue.clear();
    } catch {
      // ignore
    }
  }
}

/**
 * Determine which storage adapter to use based on configuration.
 * Priority: server mode (VITE_SERVER_URL set) > IndexedDB > legacy JSZip.
 *
 * (12.2) In server mode, passes singleFile and retentionDays options
 * to ServerClient.createSession so the server can configure the
 * assembly pipeline accordingly.
 */
async function selectStorageAdapter(
  tabUrl: string,
  sessionId?: string,
  downloadOptions?: FilterOptions,
): Promise<{ adapter: IStorageAdapter; sessionId: string; zip?: JSZip }> {
  // Server mode: upload resources to the microservice instead of storing locally.
  if (shouldUseServerMode()) {
    // Reuse existing session if one was created during INITIALIZE_DIFFERENTIAL_SCRAPING
    // (the incremental scrolling flow creates the session before scrolling starts
    // so that HTML chunks can be uploaded in real-time via SCROLL_AND_EXTRACT_DIFF).
    const existingSessionId = getActiveServerSessionId();
    let serverSessionId: string;

    if (existingSessionId) {
      serverSessionId = existingSessionId;
    } else {
      serverSessionId = await serverClient.createSession(tabUrl, {
        singleFile: downloadOptions?.singleFile ?? false,
        retentionDays: 7, // Default retention; could be made configurable via UI
      });
      // (12.3) Set the active server session so the SCROLL_AND_EXTRACT_DIFF
      // message handler can upload HTML chunks in real-time during scrolling.
      setActiveServerSession(serverSessionId);
    }

    const adapter = new ServerStorageAdapter(serverClient);
    adapter.setSessionId(serverSessionId);
    return {
      adapter,
      sessionId: serverSessionId,
    };
  }

  // IndexedDB mode (local, default when VITE_SERVER_URL is not set).
  if (USE_INDEXEDDB) {
    const finalSessionId = sessionId || await SessionManager.createSession(tabUrl);
    return {
      adapter: new IndexedDBAdapter(finalSessionId),
      sessionId: finalSessionId
    };
  }

  // Legacy JSZip mode (retained for rollback only).
  const zip = new JSZip();
  return {
    adapter: new JSZipAdapter(zip),
    sessionId: sessionId || `jszip-${Date.now()}`,
    zip
  };
}

async function executeDownload(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  assemblyJobId?: string,
  tabId?: number,
) {
  // Check network connectivity
  try {
    const online = await new Promise<boolean>((resolve) => {
      // Simple connectivity check
      fetch("https://www.google.com/favicon.ico", {
        method: "HEAD",
        mode: "no-cors",
      })
        .then(() => resolve(true))
        .catch(() => resolve(false));

      // Fallback timeout
      setTimeout(() => resolve(false), 5000);
    });

    if (!online) {
      sendMessage(
        { key: "error.noInternet" },
      );
      // Continue with basic HTML download only
      if (!downloadOptions.downloadHTML && !downloadOptions.singleFile) {
        sendMessage(
          { key: "error.enableHtmlForOffline" },
        );
        return;
      }
    }
  } catch (error) {
    // Continue with download but warn about potential issues
    sendMessage({ key: "error.networkCheckFailed" });
  }

  // Select storage adapter (IndexedDB or JSZip)
  // (12.2) Pass downloadOptions so server session gets singleFile/retentionDays
  const { adapter: storage, sessionId } = await selectStorageAdapter(tabUrl, undefined, downloadOptions);
  
  let currentSessionId = sessionId;

  // (12.1) Branch to server-mode flow when VITE_SERVER_URL is set.
  // This replaces local HTML merging, ZIP generation, and panel-download
  // with server-side HTML upload, finalization, and chrome.downloads.download.
  if (shouldUseServerMode()) {
    try {
      await executeDownloadServerMode(
        html, tabUrl, downloadOptions, sendMessage,
        storage as ServerStorageAdapter, sessionId, tabId,
      );
    } catch (outerError) {
      throw outerError;
    }
    return;
  }
  
  try {
    // Update session status
    if (USE_INDEXEDDB) {
      await SessionManager.updateSession(sessionId, { status: 'scraping' });
    }
    
    const data = getResources(html);

  const u = new URL(tabUrl || "");

  // Generate a safe filename from the URL
  // Remove protocols and common prefixes
  const domain = u.hostname.replace(/^www\./i, "");
  
  // Clean hostname: allow only alphanumeric, dots, and hyphens
  const hostname = domain.replace(/[^a-z0-9.-]/gi, "_") || "website";
  
  // Clean path: allow only alphanumeric, dots, and hyphens, replace others with hyphens
  const pathParts = u.pathname
    .split("/")
    .filter((part) => part.length > 0)
    .map(part => part.replace(/[^a-z0-9.-]/gi, "-"));
    
  let safePath = pathParts.join("-");

  // Limit filename length and ensure it's not empty
  // We keep it short to avoid OS/Browser limits (usually 255 total)
  if (safePath.length > 50) {
    safePath = safePath.substring(0, 50);
  }
  
  const timestamp = Date.now();

  let zipFilename: string;
  if (downloadOptions.singleFile) {
    // For single files, we use .html
    const baseName = safePath ? `${hostname}-${safePath}` : hostname;
    zipFilename = `${baseName}-${timestamp}`.substring(0, 200) + ".html";
  } else {
    // For ZIPs
    const baseName = safePath ? `${hostname}-${safePath}` : hostname;
    zipFilename = `${baseName}-${timestamp}`.substring(0, 200) + ".zip";
  }

  // Download images BEFORE processing HTML so we know the correct filenames
  // (including proper extensions from Content-Type for extension-less URLs)
  let imageFilenameMap = new Map<string, string>();
  if (downloadOptions.downloadImages) {
    imageFilenameMap = await processImages(data.images, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadHTML) {
    sendMessage({ key: "status.creatingIndex" });

    // Handle incremental assembly if job ID is provided
    if (assemblyJobId) {
      try {
        const finalizeResult = finalizeIncrementalMerge(assemblyJobId);
        
        if (!finalizeResult.success) {
          sendMessage(`Error: ${finalizeResult.error}`);
          
          // Fall back to regular HTML processing
          await processRegularHtml(html, storage, tabUrl, sendMessage, imageFilenameMap);
        } else {
          // Use the assembled HTML
          const finalHtml = finalizeResult.html;
          if (finalHtml) {
            await addIndexHtml(finalHtml, storage, tabUrl, imageFilenameMap);
            sendMessage({ key: "status.htmlAssembled" });
          } else if (finalizeResult.blob) {
            // Handle blob case for large files
            await addIndexHtmlFromBlob(finalizeResult.blob, storage);
            sendMessage({ key: "status.largeHtmlAssembled" });
          }
        }
      } catch {
        sendMessage({ key: "status.htmlAssemblyError" });
        await processRegularHtml(html, storage, tabUrl, sendMessage, imageFilenameMap);
      }
    } else {
      // Regular HTML processing
      await processRegularHtml(html, storage, tabUrl, sendMessage, imageFilenameMap);
    }
  }

  if (downloadOptions.downloadAssets) {
    await processAssets(data, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadDocuments) {
    await processDocuments(data.documents, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadLinks) {
    // Check if full scraping is enabled
    if (downloadOptions.downloadLinksFullScraping && tabId) {
      sendMessage({ key: "status.scrapingLinkedPages" });

      // Create asset registry and register main page assets
      const assetRegistry = new AssetRegistry();

      // Register main page assets to avoid duplicate downloads.
      // IMPORTANT: use fixFilename() so path keys match what linked-page-scraper.ts
      // registers — without it, dedup checks always miss and linked pages re-download
      // every main-page asset. (Bug C1 fix.)
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
        assetRegistry.register(fullUrl, `documents/${fixFilename(docUrl)}`, 0);
      }

      // Create linked page scraper with options
      const linkedPageScraper = new LinkedPageScraper(assetRegistry, {
        maxPages: downloadOptions.linkedPagesMaxCount,
        delayBetweenPages: downloadOptions.linkedPagesDelay,
        includeExternal: downloadOptions.linkedPagesIncludeExternal,
        pageTimeout: downloadOptions.linkedPagesTimeout,
      });

      // Guard text extraction with downloadContentAsText check
      linkedPageScraper.setExtractText(!!downloadOptions.downloadContentAsText);

      // Share the main page's image filename map so linked pages can reference
      // already-downloaded images with correct filenames (including proper extensions)
      setGlobalImageFilenameMap(imageFilenameMap);

      // Queue all discovered links
      setCurrentScraper(linkedPageScraper);
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

      // Process the queue sequentially in the same tab
      try {
        const linkedPageText = await linkedPageScraper.processQueue(tabId, storage, sendMessage);
        // Append linked page text to main content text for local mode
        if (linkedPageText && downloadOptions.downloadContentAsText) {
          data.text += linkedPageText;
        }
      } finally {
        setCurrentScraper(null);
      }
    } else {
      await processLinks(data.links, storage, tabUrl, sendMessage);
    }
  }

  if (downloadOptions.downloadContentAsText) {
    sendMessage({ key: "status.downloadingContent" });
    await addContentText(data.text, storage);
    sendMessage({ key: "status.contentDownloaded" });
  }

  try {
    let blob: Blob | undefined;
    let zipFilenameFinal = zipFilename;

    if (downloadOptions.singleFile && !shouldUseServerMode()) {
      // Single-file mode in local builds: fetch all resources and inline as base64.
      // In server mode this branch is intentionally skipped — the server's zip_assembler.py
      // handles single-file inlining on already-uploaded resources (task 6.5), preventing
      // double-fetching and ensuring the merged (not raw-chunk) HTML is used. (Bug C4 fix.)
      sendMessage({ key: "status.creatingIndex" });
      const singleFileHtml = await convertToSingleFileHtml(html, tabUrl);
      blob = new Blob([singleFileHtml], { type: "text/html;charset=UTF-8" });
      zipFilenameFinal = zipFilename.replace(".zip", ".html");
    } else {      
      if (USE_INDEXEDDB) {
        // Stream-based Split Zip Generation
        sendMessage({ key: "status.creatingPackage" });
        updateCheckpointPhase("packing");
        sendMessage({ key: "status.generatingSplitZip" });

        // Verify the side panel is available before starting multi-part download
        const panelAlive = await isPanelAlive();
        if (!panelAlive) {
          throw new PanelUnavailableError(
            "Extension panel is not available. Please keep the extension panel open during downloads."
          );
        }

        const zip = new JSZip();

        // Load all file metadata from IndexedDB
        const files = await FileStore.getFileMetadata(sessionId);

        // Add all files to JSZip as promises (lazy-ish loading)
        for (const file of files) {
          zip.file(file.path, FileStore.getFileBlobById(file.id).then(blob => {
             if (!blob) throw new Error(`Blob not found for id ${file.id}`);
             return blob;
          }));
        }

        const generator = new SplitZipGenerator(zip); // Default 25MB chunks

        // Handle parts as they are generated
        generator.onPartReady(async (blob, partNumber, isLast, totalParts) => {
          // Memory pressure check before downloading each part
          const memoryStats = memoryManager.getMemoryStats();

          // Pause if memory pressure is critical
          if (memoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL) {
            sendMessage({ key: "status.waitingForCleanup", options: { part: partNumber } });
            await new Promise(resolve => setTimeout(resolve, 5000));
            if (typeof (self as any).gc === 'function') {
              (self as any).gc();
            }
          }

          // Verify panel is still alive before each part
          const stillAlive = await isPanelAlive();
          if (!stillAlive) {
            throw new PanelUnavailableError(
              "Extension panel was closed during download. Please keep the extension panel open during downloads."
            );
          }

          sendMessage({ key: "status.downloadingPart", options: { part: partNumber, total: totalParts } });
          
          let partFilename: string;
          const nameWithoutExt = zipFilenameFinal.replace(/\.zip$/i, '');
          
          if (isLast) {
             partFilename = `${nameWithoutExt}.zip`;
          } else {
             const ext = String(partNumber).padStart(2, '0');
             partFilename = `${nameWithoutExt}.z${ext}`;
          }

          // Download via side panel (where URL.createObjectURL is available)
          await downloadViaPanelAndWait(blob, partFilename, false, tabId);

          // Add delay between parts to allow memory cleanup
          if (!isLast) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (typeof (self as any).gc === 'function') {
              (self as any).gc();
            }
          }
        });

        // Start generation
        await generator.start();
        
        sendMessage({ key: "status.downloadCompleteZipInstruction" });
        sendMessage({ key: "status.complete" });

        blob = undefined; // Handled
      } else {
        // ... Legacy JSZip mode
        // const partitions = await partitionFiles((storage as JSZipAdapter).zip);
        // ... (keep legacy logic if needed, or just force single file)
          const jsZipAdapter = storage as JSZipAdapter;
          blob = await jsZipAdapter.zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: { level: 6 },
          });
      }
    }

    if (blob) {
      if (blob.size === 0) {
        throw new Error("Blob is empty");
      }

      await initiateDownload(blob, zipFilenameFinal, (msg) => {
          if (typeof msg === 'string') sendMessage(msg);
          else sendMessage(msg);
      }, tabId);
    }
    // If blob is undefined, multi-part download was already handled above

  } catch (error) {    
    // Mark session as failed if using IndexedDB
    if (USE_INDEXEDDB) {
      await SessionManager.failSession(currentSessionId, error instanceof Error ? error.message : 'Unknown error');
    }
    
    // Handle panel unavailable errors with a user-friendly message
    if (error instanceof PanelUnavailableError) {
      sendMessage({ key: "app.panelUnavailable" });
      throw error;
    }
    
    const errorMessage =
      error instanceof Error
        ? error.message
        : { key: "status.packCreationError" };
    // @ts-ignore - sendMessage accepts object but TS might benefit from explicit cast/check if needed, but signature matches
    sendMessage(errorMessage);
    throw error; // Re-throw to allow calling code to handle the error
  } finally {
    // Complete session if using IndexedDB
    if (USE_INDEXEDDB) {
      try {
        const session = await SessionManager.getSession(currentSessionId);
        if (session && session.status !== 'failed') {
          await SessionManager.completeSession(currentSessionId);
        }
        // Cleanup files after successful download
        await FileStore.deleteDownload(currentSessionId);
      } catch {
        // ignore
      }
    }
  }

  return data.links;
  
  } catch (outerError) {
    // Handle errors from the main download logic    
    if (USE_INDEXEDDB) {
      await SessionManager.failSession(currentSessionId, outerError instanceof Error ? outerError.message : 'Unknown error');
    }
    
    throw outerError;
  } finally {
    // Final cleanup for outer try block
  }
}

// ---------------------------------------------------------------------------
// Server-mode download flow (tasks 12.1–12.9)
// ---------------------------------------------------------------------------

/**
 * (12.1–12.9) Server-mode download flow.
 *
 * Replaces the local-mode pipeline (IndexedDB → JSZip → panel-download)
 * with: HTML chunk upload → resource upload → filename map upload →
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
  const downloadAbort = getDownloadAbortController();
  if (downloadAbort) {
    // If already aborted before we start, exit immediately
    if (downloadAbort.signal.aborted) {
      throw new DOMException("Download was cancelled", "AbortError");
    }
    // When the download-level controller aborts, also cancel the upload queue
    downloadAbort.signal.addEventListener("abort", () => {
      uploadQueue.cancel();
    }, { once: true });
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

  // Track total resources for scrape-complete signal
  let totalResourceCount = 0;

  try {
    // (12.3) Upload main page HTML as chunk to the server.
    // scrollIndex 0 = first (and possibly only) chunk for the main page.
    //
    // (13.3) Skip this upload if HTML chunks were already streamed to the
    // server during scrolling (via SCROLL_AND_EXTRACT_DIFF or
    // SERVER_UPLOAD_HTML_CHUNK). This prevents double-uploading and
    // avoids sending an empty/placeholder HTML string.
    if (!hasStreamedHtmlChunks()) {
      sendMessage({ key: "status.uploadingHtml" });
      // Do NOT send tabUrl as pageUrl for main page — the server uses
      // the absence of pageUrl to set page_url_hash="main", which the
      // assembler looks up via merge_results.get("main").
      await serverClient.uploadHtmlChunk(sessionId, html, 0, "main");
      sendMessage({ key: "status.htmlUploaded" });
    }

    // Extract resources from the HTML
    const data = getResources(html);

    // (12.5) Process images — download from origin and upload to server
    // via ServerStorageAdapter (which enqueues in UploadQueue).
    let imageFilenameMap = new Map<string, string>();
    if (downloadOptions.downloadImages) {
      imageFilenameMap = await processImages(data.images, storage, tabUrl, sendMessage);
    }

    // (12.6) Upload filename map after processImages completes for the main page.
    // The server needs the map before it can convert HTML URLs during assembly.
    // We await the 200 ACK before proceeding to finalization.
    if (imageFilenameMap.size > 0) {
      const mapObj = Object.fromEntries(imageFilenameMap);
      await serverClient.uploadFilenameMap(sessionId, mapObj);
    }

    // (12.5) Process CSS/JS assets — uploaded to server via ServerStorageAdapter.
    if (downloadOptions.downloadAssets) {
      await processAssets(data, storage, tabUrl, sendMessage);
    }

    // (12.5) Process documents — uploaded to server via ServerStorageAdapter.
    if (downloadOptions.downloadDocuments) {
      await processDocuments(data.documents, storage, tabUrl, sendMessage);
    }

    // (12.5 + 12.10 + 12.11) Process linked pages with server-mode support.
    if (downloadOptions.downloadLinks) {
      if (downloadOptions.downloadLinksFullScraping && tabId) {
        sendMessage({ key: "status.scrapingLinkedPages" });

        const assetRegistry = new AssetRegistry();

        // Register main page assets (same dedup logic as local mode)
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
          assetRegistry.register(fullUrl, `documents/${fixFilename(docUrl)}`, 0);
        }

        // Create linked page scraper with server-mode flag
        const linkedPageScraper = new LinkedPageScraper(assetRegistry, {
          maxPages: downloadOptions.linkedPagesMaxCount,
          delayBetweenPages: downloadOptions.linkedPagesDelay,
          includeExternal: downloadOptions.linkedPagesIncludeExternal,
          pageTimeout: downloadOptions.linkedPagesTimeout,
          serverSessionId: shouldUseServerMode() ? sessionId : undefined,
        });

        // Guard text extraction with downloadContentAsText check
        linkedPageScraper.setExtractText(!!downloadOptions.downloadContentAsText);

        // Share main page image filename map
        setGlobalImageFilenameMap(imageFilenameMap);

        // Queue all discovered links
        setCurrentScraper(linkedPageScraper);
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
          const linkedPageText = await linkedPageScraper.processQueue(tabId, storage, sendMessage);
          // Upload linked page text content to the server.
          // ORDERING: This must happen BEFORE the main page text upload below
          // (line ~818) because the server's uploadContent endpoint appends to
          // content.txt in file order — the linked page text delimiter format
          // assumes it follows the main page's content.
          if (linkedPageText && downloadOptions.downloadContentAsText) {
            await serverClient.uploadContent(sessionId, linkedPageText);
          }
        } finally {
          setCurrentScraper(null);
        }
      } else {
        await processLinks(data.links, storage, tabUrl, sendMessage);
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

    sendMessage({ key: "status.sendingScrapeComplete" });
    await serverClient.scrapeComplete(sessionId, totalResourceCount);
    sendMessage({ key: "status.scrapeComplete" });
    updateCheckpointPhase("uploading");

    // Wait for all resource uploads to complete before finalizing.
    // Finalization requires all resources to be on the server.
    sendMessage({ key: "status.waitingForUploads" });
    try {
      const queueProgress = uploadQueue.getProgress();
      console.log(
        `[ServerMode] Waiting for uploads: ${queueProgress.completedCount}/${queueProgress.totalCount} completed, ` +
        `${queueProgress.failedCount} failed, ${uploadQueue.getResourceCount()} total resources`,
      );
      await uploadQueue.waitForAll();
      console.log("[ServerMode] All uploads completed");
    } catch (err) {
      // Queue may be cancelled — continue anyway, finalization
      // will proceed and the server will assemble whatever it has.
      console.warn("[ServerMode] Upload queue error:", err);
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
      // Local fallback callback — returns true if user chose local mode
      async (reason, errorMessage) => {
        sendMessage({ key: "status.serverFallbackOffer", options: { reason, errorMessage } });
        // The UI layer (task 15.5) will show a dialog. For now, we
        // send the message and return false (don't fall back automatically).
        // The user must explicitly choose local fallback via the UI.
        // When they do, a SERVER_LOCAL_FALLBACK message is sent (task 13.1),
        // which re-runs the download in local mode.
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
    );

    // (15.3 + 15.4) Send the server download URL to the UI so it can display
    // a "Download from server" button and show the URL in DownloadComplete.
    // Also include the URL in the status.complete message as a defensive
    // measure — the UI handler merges both, ensuring the download URL is
    // available even if serverDownloadReady was missed or reordered.
    const serverCompleteOptions = downloadResult?.downloadUrl
      ? { downloadUrl: downloadResult.downloadUrl, isSingleFile: downloadOptions.singleFile }
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

  } catch (error) {
    // (12.9) Categorize server-mode errors and offer local fallback.
    const errorMessage = error instanceof Error ? error.message : "Unknown server error";
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
          reason: error instanceof ServerUnavailableError ? "server_unavailable"
            : error instanceof AssemblyTimeoutError ? "assembly_timeout"
            : error instanceof AssemblyFailedError ? "assembly_failed"
            : "auth_failed",
        },
      });
    } else {
      // Generic error — send as regular failure message
      sendMessage({ key: "status.failedWithError", options: { error: errorMessage } });
    }

    throw error;
  } finally {
    // Clear the active server session so subsequent scrolling
    // doesn't try to upload to a stale session.
    setActiveServerSession(null);
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

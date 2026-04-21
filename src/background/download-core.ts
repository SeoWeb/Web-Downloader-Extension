
import JSZip from "jszip";
import { getResources } from "./resources";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";
import { requestQueue } from "../utils/RequestQueue";
import { addIndexHtml } from "./fileHandlers";
import { cleanupAfterDownload } from "./cleanupHandlers";
import { finalizeIncrementalMerge } from "./merge-html";
import { FilterOptions } from "../types/filterTypes";
import { downloadId, setDownloadInProgress, getDownloadInProgress } from "./download-state";
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
import { SplitZipGenerator } from "./zip-stream-splitter";

// IndexedDB Storage imports
import { IStorageAdapter, JSZipAdapter, IndexedDBAdapter } from "./storage/storage-adapter";
import { SessionManager } from "./storage/session-manager";
import { FileStore } from "./storage/file-store";

// Configuration
const USE_INDEXEDDB = true; // Feature flag for IndexedDB mode

import { setCurrentScraper } from "./scraper-state";

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

  // Initial memory check and cleanup
  const initialMemoryStats = memoryManager.getMemoryStats();
  if (initialMemoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL) {
    sendMessage(
      { key: "error.memoryPressure" },
    );
    return;
  }

  await setDownloadInProgress(true);

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
 * Determine which storage adapter to use based on configuration
 */
async function selectStorageAdapter(
  tabUrl: string,
  sessionId?: string
): Promise<{ adapter: IStorageAdapter; sessionId: string; zip?: JSZip }> {
  // Force IndexedDB if enabled
  if (USE_INDEXEDDB) {
    const finalSessionId = sessionId || await SessionManager.createSession(tabUrl);
    return {
      adapter: new IndexedDBAdapter(finalSessionId),
      sessionId: finalSessionId
    };
  }

  // Legacy JSZip mode
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
  const { adapter: storage, sessionId } = await selectStorageAdapter(tabUrl);
  
  let currentSessionId = sessionId;
  
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

      // Register main page assets to avoid duplicate downloads
      for (const cssUrl of data.css) {
        const fullUrl = new URL(cssUrl, tabUrl).href;
        assetRegistry.register(fullUrl, `assets/css/${cssUrl}`, 0);
      }
      for (const jsUrl of data.js) {
        const fullUrl = new URL(jsUrl, tabUrl).href;
        assetRegistry.register(fullUrl, `assets/js/${jsUrl}`, 0);
      }
      for (const imgUrl of data.images) {
        const fullUrl = new URL(imgUrl, tabUrl).href;
        assetRegistry.register(fullUrl, `assets/images/${imgUrl}`, 0);
      }

      // Create linked page scraper with options
      const linkedPageScraper = new LinkedPageScraper(assetRegistry, {
        maxPages: downloadOptions.linkedPagesMaxCount,
        delayBetweenPages: downloadOptions.linkedPagesDelay,
        includeExternal: downloadOptions.linkedPagesIncludeExternal,
        pageTimeout: downloadOptions.linkedPagesTimeout,
      });

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
        await linkedPageScraper.processQueue(tabId, storage, sendMessage);
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

    if (downloadOptions.singleFile) {
      sendMessage({ key: "status.creatingIndex" });
      const singleFileHtml = await convertToSingleFileHtml(html, tabUrl);
      blob = new Blob([singleFileHtml], { type: "text/html;charset=UTF-8" });
      zipFilenameFinal = zipFilename.replace(".zip", ".html");
    } else {      
      if (USE_INDEXEDDB) {
        // Stream-based Split Zip Generation
        sendMessage({ key: "status.creatingPackage" });
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

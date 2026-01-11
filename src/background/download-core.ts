
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
import { LinkedPageScraper } from "./linked-page-scraper";
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
    console.error("No tab URL provided");
    sendMessage({ key: "error.noUrl" });
    return;
  }

  // Prevent concurrent downloads
  if (await getDownloadInProgress()) {
    console.warn("Download already in progress, rejecting new request");
    sendMessage({ key: "error.downloadInProgress" });
    return;
  }

  // Initial memory check and cleanup
  const initialMemoryStats = memoryManager.getMemoryStats();
  if (initialMemoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL) {
    console.error("Cannot start download - critical memory pressure");
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
    console.error("Download failed:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    
    // Categorize error for better user feedback
    let userFriendlyMessage = `Download failed: ${errorMessage}`;
    let isMemoryError = false;

    if (
      errorMessage.includes("memory") ||
      errorMessage.includes("size") ||
      errorMessage.includes("limit") ||
      errorMessage.includes("quota")
    ) {
      isMemoryError = true;
      userFriendlyMessage = "Download failed due to memory limits. Attempting cleanup...";
    } else if (
      errorMessage.includes("network") ||
      errorMessage.includes("fetch") ||
      errorMessage.includes("connection") ||
      errorMessage.includes("offline")
    ) {
      userFriendlyMessage = "Download failed due to network issues. Please check your connection.";
    }

    sendMessage(userFriendlyMessage);

    // If it's a memory-related error, perform cleanup
    if (isMemoryError) {
      await memoryManager.forceCleanup();
      sendMessage(
        "Memory cleanup performed. Please try downloading again with fewer options selected.",
      );
    }
  } finally {
    // Always reset the flag when done and cleanup
    await setDownloadInProgress(false);

    // Cleanup download-specific resources
    try {
      await cleanupAfterDownload(downloadId);
      
      // Clear the queue after download completion
      await requestQueue.clear();
    } catch (cleanupError) {
      console.error("Error during final cleanup:", cleanupError);
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
      console.warn("No internet connection detected");
      // Continue with basic HTML download only
      if (!downloadOptions.downloadHTML && !downloadOptions.singleFile) {
        sendMessage(
          { key: "error.enableHtmlForOffline" },
        );
        return;
      }
    }
  } catch (error) {
    console.warn("Network check failed, continuing with download:", error);
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
  const hostname = u.hostname.replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "");
  const path = u.pathname
    .split("/")
    .slice(1)
    .filter((part) => part.length > 0) // Remove empty parts
    .join("-")
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-"); // Replace invalid characters with hyphens

  // Limit filename length and ensure it's not empty
  const safePath =
    path.length > 100 ? path.substring(0, 100) : path || "webpage";
  const timestamp = Date.now();

  let zipFilename: string;
  if (downloadOptions.singleFile) {
    zipFilename = `${hostname}-${safePath}-${timestamp}.html`;
  } else {
    zipFilename = `${hostname}-${safePath}-${timestamp}.zip`;
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
          await processRegularHtml(html, storage, tabUrl, sendMessage);
        } else {
          // Use the assembled HTML
          const finalHtml = finalizeResult.html;
          if (finalHtml) {
            await addIndexHtml(finalHtml, storage, tabUrl);
            sendMessage("HTML content assembled and added to download");
          } else if (finalizeResult.blob) {
            // Handle blob case for large files
            await addIndexHtmlFromBlob(finalizeResult.blob, storage);
            sendMessage("Large HTML content processed and added to download");
          }
        }
      } catch (error) {
        console.error("Error during incremental HTML assembly:", error);
        sendMessage("Error during HTML assembly, falling back to regular processing");
        await processRegularHtml(html, storage, tabUrl, sendMessage);
      }
    } else {
      // Regular HTML processing
      await processRegularHtml(html, storage, tabUrl, sendMessage);
    }
  }

  if (downloadOptions.downloadAssets) {
    await processAssets(data, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadDocuments) {
    await processDocuments(data.documents, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadImages) {
    await processImages(data.images, storage, tabUrl, sendMessage);
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
        } catch (error) {
          console.warn(`Invalid link URL: ${link}`, error);
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
        sendMessage(`Generating split zip archive...`);

        // const { SplitZipGenerator } = await import("./zip-stream-splitter"); // Dynamic import removed
        const zip = new JSZip();

        // Load all file metadata from IndexedDB
        const files = await FileStore.getFileMetadata(sessionId);

        // Add all files to JSZip as promises (lazy-ish loading)
        for (const file of files) {
          // We pass a promise that resolves to the blob
          // JSZip will resolve this when it processes the file in the stream
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
            console.warn(`Critical memory pressure detected before part ${partNumber}, waiting for cleanup...`);
            sendMessage(`Waiting for memory cleanup before part ${partNumber}...`);
            
            // Wait for memory to stabilize
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Force garbage collection if available (service workers use self, not global)
            if (typeof (self as any).gc === 'function') {
              (self as any).gc();
            }
          }

          sendMessage(`Downloading part ${partNumber}/${totalParts}`);
          
          let partFilename: string;
          const nameWithoutExt = zipFilenameFinal.replace(/\.zip$/i, '');
          
          if (isLast) {
             // The last part is the .zip file
             partFilename = `${nameWithoutExt}.zip`;
          } else {
             // Previous parts are .z01, .z02, etc.
             const ext = String(partNumber).padStart(2, '0');
             partFilename = `${nameWithoutExt}.z${ext}`;
          }

          // Convert blob to data URL for download
          // const reader = new FileReader();
          // const dataUrl = await new Promise<string>((resolve, reject) => {
          //   reader.onloadend = () => resolve(reader.result as string);
          //   reader.onerror = reject;
          //   reader.readAsDataURL(blob);
          // });
          // Use blob URL instead of data URL to avoid base64 memory overhead
          // const blobUrl = URL.createObjectURL(blob);
          // Service workers don't support URL.createObjectURL, so we use data URLs
          // To minimize memory impact, we read in chunks and clear references aggressively
          let dataUrl: string;
          try {
            const reader = new FileReader();
            dataUrl = await new Promise<string>((resolve, reject) => {
              reader.onloadend = () => {
                if (reader.result) {
                  resolve(reader.result as string);
                } else {
                  reject(new Error('Failed to read blob'));
                }
              };
              reader.onerror = () => reject(new Error('FileReader error'));
              reader.readAsDataURL(blob);
            });
          } catch (readError) {
            console.error(`Failed to read blob for part ${partNumber}:`, readError);
            throw readError;
          }

          try {
            const downloadId = await chrome.downloads.download({
              url: dataUrl,
              filename: partFilename,
              saveAs: false, // Don't prompt for every part
              conflictAction: "uniquify",
            });
            
            // Wait for download to complete
             await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                chrome.downloads.onChanged.removeListener(listener);
                reject(new Error('Download timeout'));
              }, 300000); // 5 minute timeout
              
              const listener = (delta: chrome.downloads.DownloadDelta) => {
                if (delta.id === downloadId && delta.state) {
                  if (delta.state.current === 'complete') {
                    clearTimeout(timeout);
                    chrome.downloads.onChanged.removeListener(listener);
                    resolve();
                  } else if (delta.state.current === 'interrupted') {
                    clearTimeout(timeout);
                    chrome.downloads.onChanged.removeListener(listener);
                    reject(new Error('Download interrupted'));
                  }
                }
              };
              
              chrome.downloads.onChanged.addListener(listener);
            });
          } catch (error) {
             console.error(`Failed to download part ${partNumber}:`, error);
             throw error;
          } finally {
            // Explicitly clear the data URL string to free memory
            dataUrl = '';
          }

          // Add delay between parts to allow memory cleanup and garbage collection
          if (!isLast) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Force garbage collection if available (service workers use self, not global)
            if (typeof (self as any).gc === 'function') {
              (self as any).gc();
            }
          }
        });

        // Start generation
        await generator.start();
        
        sendMessage("Download complete! Open the .zip file to extract the whole website.");
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
    console.error("Error creating download package:", error);
    
    // Mark session as failed if using IndexedDB
    if (USE_INDEXEDDB) {
      await SessionManager.failSession(currentSessionId, error instanceof Error ? error.message : 'Unknown error');
    }
    
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to create download package";
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
      } catch (cleanupError) {
        console.error("Error during session cleanup:", cleanupError);
      }
    }
  }

  return data.links;
  
  } catch (outerError) {
    // Handle errors from the main download logic
    console.error("Error during download execution:", outerError);
    
    if (USE_INDEXEDDB) {
      await SessionManager.failSession(currentSessionId, outerError instanceof Error ? outerError.message : 'Unknown error');
    }
    
    throw outerError;
  } finally {
    // Final cleanup for outer try block
  }
}

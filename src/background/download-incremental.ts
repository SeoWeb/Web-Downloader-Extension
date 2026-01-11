
import JSZip from "jszip";
import { FilterOptions } from "../types/filterTypes";
import { finalizeIncrementalMerge, cleanupIncrementalMerges } from "./merge-html";
import { addIndexHtml, addContentText } from "./fileHandlers";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";
import { downloadId, setDownloadInProgress, getDownloadInProgress } from "./download-state";
import { initiateDownload, performInitialCleanup } from "./download-utils";
import { processAssets, processDocuments, processImages, processLinks, addIndexHtmlFromBlob } from "./download-processors";
import { cleanupAfterDownload } from "./cleanupHandlers";
import { JSZipAdapter } from "./storage/storage-adapter";

/**
 * Enhanced download function with incremental HTML assembly support
 */
export async function downloadResourcesWithIncrementalAssembly(
  assemblyJobId: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  tabId?: number,
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

  // Initial memory check
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

    // Execute download with incremental assembly
    await executeDownloadWithIncrementalAssembly(assemblyJobId, tabUrl, downloadOptions, sendMessage, tabId);
  } catch (error) {
    console.error("Incremental download failed:", error);

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    sendMessage(`Download failed: ${errorMessage}`);

    // If it's a memory-related error, perform cleanup
    if (
      errorMessage.includes("memory") ||
      errorMessage.includes("size") ||
      errorMessage.includes("limit")
    ) {
      await memoryManager.forceCleanup();
      sendMessage(
        "Memory cleanup performed due to download failure. Please try again.",
      );
    }
  } finally {
    // Always reset the flag when done and cleanup
    await setDownloadInProgress(false);

    // Cleanup download-specific resources
    try {
      await cleanupAfterDownload(downloadId);
    } catch (cleanupError) {
      console.error("Error during final cleanup:", cleanupError);
    }

    // Clean up incremental assembly jobs
    try {
      cleanupIncrementalMerges();
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Execute download with incremental HTML assembly
 */
async function executeDownloadWithIncrementalAssembly(
  assemblyJobId: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  tabId?: number,
) {
  const zip = new JSZip();
  const storage = new JSZipAdapter(zip);
  
  // Generate filename
  const u = new URL(tabUrl || "");
  const hostname = u.hostname.replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "");
  const path = u.pathname
    .split("/")
    .slice(1)
    .filter((part) => part.length > 0)
    .join("-")
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-");

  const safePath = path.length > 100 ? path.substring(0, 100) : path || "webpage";
  const timestamp = Date.now();
  const zipFilename = `${hostname}-${safePath}-${timestamp}.zip`;

  // Process HTML with incremental assembly
  if (downloadOptions.downloadHTML) {
    sendMessage({ key: "status.processingHtmlIncremental" });

    // Finalize the incremental assembly job
    const finalizeResult = finalizeIncrementalMerge(assemblyJobId);
    
    if (!finalizeResult.success) {
      throw new Error(`Failed to finalize HTML assembly: ${finalizeResult.error}`);
    }

    if (finalizeResult.html) {
      await addIndexHtml(finalizeResult.html, storage, tabUrl);
      sendMessage({ key: "status.incrementalHtmlAdded" });
    } else if (finalizeResult.blob) {
      await addIndexHtmlFromBlob(finalizeResult.blob, storage);
      sendMessage({ key: "status.largeHtmlAdded" });
    }
  }
  
  const data = { css: [], js: [], images: [], documents: [], links: [], text: "" }; // Equivalent to getResources("")
  
  if (downloadOptions.downloadAssets) {
    // Process CSS and JS files
    await processAssets(data, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadDocuments) {
    await processDocuments(data.documents, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadImages) {
    await processImages(data.images, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadLinks) {
    await processLinks(data.links, storage, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadContentAsText) {
    await addContentText(data.text, storage);
  }

  // Create and initiate download
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  await initiateDownload(blob, zipFilename, (msg) => {
      if (typeof msg === 'string') sendMessage(msg);
      else sendMessage(msg);
  }, tabId);
}

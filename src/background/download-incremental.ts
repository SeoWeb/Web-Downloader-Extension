
import JSZip from "jszip";
import { FilterOptions } from "../types/filterTypes";
import { finalizeIncrementalMerge, cleanupIncrementalMerges } from "./merge-html";
import { addIndexHtml, addContentText } from "./fileHandlers";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";
import { downloadId, setDownloadInProgress, getDownloadInProgress } from "./download-state";
import { formatBytes, createAndInitiateDownload, performInitialCleanup } from "./download-utils";
import { processAssets, processDocuments, processImages, processLinks, addIndexHtmlFromBlob } from "./download-processors";
import { cleanupAfterDownload } from "./cleanupHandlers";

/**
 * Enhanced download function with incremental HTML assembly support
 */
export async function downloadResourcesWithIncrementalAssembly(
  assemblyJobId: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
) {
  console.log(`Starting download with incremental assembly for job: ${assemblyJobId}`);

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
    await executeDownloadWithIncrementalAssembly(assemblyJobId, tabUrl, downloadOptions, sendMessage);
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
      console.log("Memory-related error detected, performing cleanup...");
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
      const cleanedJobs = cleanupIncrementalMerges();
      if (cleanedJobs > 0) {
        console.log(`Cleaned up ${cleanedJobs} old assembly jobs`);
      }
    } catch (cleanupError) {
      console.error("Error during assembly job cleanup:", cleanupError);
    }

    // Final memory stats
    const finalMemoryStats = memoryManager.getMemoryStats();
    console.log("Incremental download process completed. Final memory stats:", {
      memoryUsed: formatBytes(finalMemoryStats.totalMemoryUsed),
      memoryPressure: finalMemoryStats.memoryPressureLevel,
      completedDownloads: finalMemoryStats.completedDownloads,
    });

    console.log("Incremental download process completed");
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
) {
  const zip = new JSZip();
  
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

  console.log("Generated incremental filename:", zipFilename);

  // Process HTML with incremental assembly
  if (downloadOptions.downloadHTML) {
    console.log("Processing HTML with incremental assembly");
    sendMessage({ key: "status.processingHtmlIncremental" });

    // Finalize the incremental assembly job
    const finalizeResult = finalizeIncrementalMerge(assemblyJobId);
    
    if (!finalizeResult.success) {
      throw new Error(`Failed to finalize HTML assembly: ${finalizeResult.error}`);
    }

    if (finalizeResult.html) {
      await addIndexHtml(finalizeResult.html, zip, tabUrl);
      console.log("Incrementally assembled HTML added to ZIP");
      sendMessage({ key: "status.incrementalHtmlAdded" });
    } else if (finalizeResult.blob) {
      await addIndexHtmlFromBlob(finalizeResult.blob, zip);
      console.log("Large HTML content processed and added to download");
      sendMessage({ key: "status.largeHtmlAdded" });
    }
  }

  // Process other resources (same as regular download)
  // Note: getResources normally parses HTML. Here we don't have the full HTML easily accessible as a string if it was a blob.
  // The original code does: `const data = getResources("");` which returns empty lists.
  // This means incremental assembly download DOES NOT download assets unless they were somehow pre-calculated? 
  // Let's check original code.
  // Line 1543: `const data = getResources(""); // Empty HTML since we're using incremental assembly`
  // Yes. It seems incremental mode relies on the merged HTML being sufficient or resources handled separately?
  // But subsequent lines call `processAssets(data, ...)` which checks `data.css.length`.
  // If `data` is empty, this does nothing.
  // So incremental assembly mode effectively skips asset downloading?
  // That seems to be the implementation. I will stick to it.
  
  const data = { css: [], js: [], images: [], documents: [], links: [], text: "" }; // Equivalent to getResources("")
  
  if (downloadOptions.downloadAssets) {
    // Process CSS and JS files
    await processAssets(data, zip, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadDocuments) {
    await processDocuments(data.documents, zip, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadImages) {
    await processImages(data.images, zip, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadLinks) {
    await processLinks(data.links, zip, tabUrl, sendMessage);
  }

  if (downloadOptions.downloadContentAsText) {
    await addContentText(data.text, zip);
  }

  // Create and initiate download
  await createAndInitiateDownload(zip, zipFilename, sendMessage);
}

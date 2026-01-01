
import JSZip from "jszip";
import { getResources } from "./resources";
import { convertToSingleFileHtml } from "./htmlUtils";
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";
import { requestQueue } from "../utils/RequestQueue";
import { addIndexHtml } from "./fileHandlers";
import { cleanupAfterDownload } from "./cleanupHandlers";
import { finalizeIncrementalMerge } from "./merge-html";
import { FilterOptions } from "../types/filterTypes";
import { downloadId, setDownloadInProgress, getDownloadInProgress } from "./download-state";
import { formatBytes, initiateDownload, performInitialCleanup } from "./download-utils";
import { 
  processRegularHtml, 
  processAssets, 
  processDocuments, 
  processImages, 
  processLinks, 
  addIndexHtmlFromBlob 
} from "./download-processors";
import { addContentText } from "./fileHandlers";

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
  console.log("Starting downloadResources for URL:", tabUrl, "tabId:", tabId);

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
      console.log("Memory-related error detected, performing cleanup...");
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
      console.log("Queue cleared after download completion");
    } catch (cleanupError) {
      console.error("Error during final cleanup:", cleanupError);
    }

    // Final memory stats
    const finalMemoryStats = memoryManager.getMemoryStats();
    console.log("Download process completed. Final memory stats:", {
      memoryUsed: formatBytes(finalMemoryStats.totalMemoryUsed),
      memoryPressure: finalMemoryStats.memoryPressureLevel,
      completedDownloads: finalMemoryStats.completedDownloads,
      queueStats: requestQueue.getStats(),
    });

    console.log("Download process completed");
  }
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

  const zip = new JSZip();
  const data = getResources(html);
  console.log("Extracted resources:", data);

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

  console.log("Generated filename:", zipFilename);

  if (downloadOptions.downloadHTML) {
    console.log("Creating index.html");
    sendMessage({ key: "status.creatingIndex" });

    // Handle incremental assembly if job ID is provided
    if (assemblyJobId) {
      try {
        console.log(`Finalizing incremental HTML assembly job: ${assemblyJobId}`);
        const finalizeResult = finalizeIncrementalMerge(assemblyJobId);
        
        if (!finalizeResult.success) {
          console.error(`Failed to finalize incremental assembly: ${finalizeResult.error}`);
          sendMessage(`Error: ${finalizeResult.error}`);
          
          // Fall back to regular HTML processing
          await processRegularHtml(html, zip, tabUrl, sendMessage);
        } else {
          // Use the assembled HTML
          const finalHtml = finalizeResult.html;
          if (finalHtml) {
            await addIndexHtml(finalHtml, zip, tabUrl);
            console.log("Incrementally assembled HTML added to ZIP");
            sendMessage("HTML content assembled and added to download");
          } else if (finalizeResult.blob) {
            // Handle blob case for large files
            console.log("Using blob for large HTML content");
            await addIndexHtmlFromBlob(finalizeResult.blob, zip);
            sendMessage("Large HTML content processed and added to download");
          }
        }
      } catch (error) {
        console.error("Error during incremental HTML assembly:", error);
        sendMessage("Error during HTML assembly, falling back to regular processing");
        await processRegularHtml(html, zip, tabUrl, sendMessage);
      }
    } else {
      // Regular HTML processing
      await processRegularHtml(html, zip, tabUrl, sendMessage);
    }
  }

  if (downloadOptions.downloadAssets) {
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
    console.log("Downloading content as text");
    sendMessage({ key: "status.downloadingContent" });
    await addContentText(data.text, zip);
    console.log("Content text downloaded");
    sendMessage({ key: "status.contentDownloaded" });
  }

  try {
    console.log("Creating final download package");
    let blob: Blob;

    if (downloadOptions.singleFile) {
      sendMessage({ key: "status.creatingIndex" });
      const singleFileHtml = await convertToSingleFileHtml(html, tabUrl);
      blob = new Blob([singleFileHtml], { type: "text/html;charset=UTF-8" });
      zipFilename = zipFilename.replace(".zip", ".html");
      console.log("Single HTML file created");
    } else {
      console.log("Generating ZIP archive");
      blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      console.log("ZIP archive created");
    }

    console.log("Preparing download");
    if (!blob || blob.size === 0) {
      throw new Error("No blob data available for download or blob is empty");
    }

    // Reuse initiateDownload from utils
    await initiateDownload(blob, zipFilename, (msg) => {
        if (typeof msg === 'string') sendMessage(msg);
        else sendMessage(msg);
    }, tabId);

  } catch (error) {
    console.error("Error creating download package:", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to create download package";
    sendMessage(errorMessage);
    throw error; // Re-throw to allow calling code to handle the error
  }

  return data.links;
}

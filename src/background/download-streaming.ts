
import JSZip from "jszip";
import { StreamingDownload } from "../types/streaming";
import { FilterOptions } from "../types/filterTypes";
import { getResources } from "./resources";
import { createZipFromDownloads } from "../utils/chunkedZip";
import { addCssFiles, addJsFiles, addDocumentFiles, addImageFiles, addHtmlFiles, addContentText } from "./fileHandlers";
import { downloadId, setDownloadInProgress, getDownloadInProgress } from "./download-state";
import { streamingDownloader, streamingFetcher } from "./download-services";
import { initiateDownload } from "./download-utils";
import { downloadResources } from "./download-core";
import { JSZipAdapter } from "./storage/storage-adapter";

/**
 * Enhanced streaming download function for large files
 */
export async function downloadResourcesWithStreaming(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  tabId?: number,
) {
  if (!tabUrl) {
    sendMessage({ key: "error.noUrl" });
    return;
  }

  // Check if any resources are large enough to benefit from streaming
  const data = getResources(html);
  const hasLargeFiles = await checkForLargeFiles(data);

  if (!hasLargeFiles) {
    // Fall back to regular download for small files
    return downloadResources(html, tabUrl, downloadOptions, sendMessage, undefined, tabId);
  }

  // Prevent concurrent downloads
  if (await getDownloadInProgress()) {
    sendMessage({ key: "error.downloadInProgress" });
    return;
  }

  await setDownloadInProgress(true);

  try {
    await executeStreamingDownload(html, tabUrl, downloadOptions, sendMessage, data, tabId);
  } catch {
    // Fall back to regular download on streaming failure
    sendMessage({ key: "status.streamingFailedFallback" });
    try {
      await downloadResources(html, tabUrl, downloadOptions, sendMessage, undefined, tabId);
    } catch (fallbackError) {
      sendMessage({ key: "status.failedWithError", options: { error: fallbackError instanceof Error ? fallbackError.message : 'Unknown error' } });
    }
  } finally {
    await setDownloadInProgress(false);
  }
}

/**
 * Execute streaming download with chunked processing
 */
async function executeStreamingDownload(
  html: string,
  tabUrl: string,
  downloadOptions: FilterOptions,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  data: ReturnType<typeof getResources>,
  tabId?: number,
) {
  const u = new URL(tabUrl || "");

  // Generate a safe filename
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

  // Create streaming downloads for all resources
  const streamingDownloads: Array<{ download: StreamingDownload; path: string }> = [];

  // Download HTML
  if (downloadOptions.downloadHTML) {
    sendMessage({ key: "status.processingHtmlIncremental" });

    // For HTML, we'll handle it directly since it's usually not too large
    streamingDownloads.push({
      download: {
        id: `html-${timestamp}`,
        url: tabUrl,
        totalSize: html.length,
        downloadedSize: html.length,
        progress: 1.0,
        chunks: [],
        status: 'completed',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: Date.now(),
        resumable: false,
        activeChunks: 0,
        chunkSize: 0,
        mimeType: 'text/html',
        filename: 'index.html',
      },
      path: 'index.html'
    });
  }

  // Download CSS files with streaming
  if (downloadOptions.downloadAssets && data.css.length > 0) {
    sendMessage({ key: "status.processingCssCount", options: { count: data.css.length } });

    for (let i = 0; i < data.css.length; i++) {
      const cssUrl = data.css[i];
      if (!cssUrl) continue;

      try {
        const shouldStream = streamingDownloader.shouldUseStreaming(cssUrl);

        if (shouldStream) {
          sendMessage({ key: "status.streamingCss", options: { current: i + 1, total: data.css.length } });
          const download = await streamingDownloader.startDownload(cssUrl, {
            chunkSize: 512 * 1024, // 512KB chunks for CSS
            maxParallelChunks: 2,
          });

          const filename = new URL(cssUrl, tabUrl).pathname.split("/").pop() || `style-${i}.css`;
          streamingDownloads.push({
            download,
            path: `styles/${filename}`,
          });
        } else {
          // Use regular download for small CSS files
          // This will be handled by the regular file handlers
        }
      } catch {
        // Fall back to regular download
      }
    }
  }

  // Download JavaScript files with streaming
  if (downloadOptions.downloadAssets && data.js.length > 0) {
    sendMessage({ key: "status.processingJsCount", options: { count: data.js.length } });

    for (let i = 0; i < data.js.length; i++) {
      const jsUrl = data.js[i];
      if (!jsUrl) continue;

      try {
        const shouldStream = streamingDownloader.shouldUseStreaming(jsUrl);

        if (shouldStream) {
          sendMessage({ key: "status.streamingJs", options: { current: i + 1, total: data.js.length } });
          const download = await streamingDownloader.startDownload(jsUrl, {
            chunkSize: 512 * 1024, // 512KB chunks for JS
            maxParallelChunks: 2,
          });

          const filename = new URL(jsUrl, tabUrl).pathname.split("/").pop() || `script-${i}.js`;
          streamingDownloads.push({
            download,
            path: `scripts/${filename}`,
          });
        }
      } catch {
        // Fall back to regular download
      }
    }
  }

  // Download images with streaming
  if (downloadOptions.downloadImages && data.images.length > 0) {
    sendMessage({ key: "status.processingImagesCount", options: { count: data.images.length } });

    for (let i = 0; i < data.images.length; i++) {
      const imageUrl = data.images[i];
      if (!imageUrl || imageUrl.startsWith("data:")) continue;

      try {
        const shouldStream = streamingDownloader.shouldUseStreaming(imageUrl);

        if (shouldStream) {
          sendMessage({ key: "status.streamingImageStart", options: { current: i + 1, total: data.images.length } });
          const download = await streamingDownloader.startDownload(imageUrl, {
            chunkSize: 1024 * 1024, // 1MB chunks for images
            maxParallelChunks: 3,
          });

          const filename = new URL(imageUrl, tabUrl).pathname.split("/").pop() || `image-${i}`;
          streamingDownloads.push({
            download,
            path: `images/${filename}`,
          });
        }
      } catch {
        // Fall back to regular download
      }
    }
  }

  // Wait for all streaming downloads to complete
  if (streamingDownloads.length > 0) {
    sendMessage({ key: "status.waitingForStreaming", options: { count: streamingDownloads.length } });

    const completionPromises = streamingDownloads.map(async ({ download }) => {
      while (download.status !== 'completed' && download.status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 100));
        // Update progress
        const progress = streamingDownloader.getProgress(download.id);
        if (progress && progress.status === 'streaming') {
          const progressPercentage = progress.totalBytes > 0
            ? (progress.bytesDownloaded / progress.totalBytes) * 100
            : 0;
          sendMessage({ 
            key: "status.streamingProgress", 
            options: { 
              completed: progress.completedChunks, 
              total: progress.totalChunks, 
              percent: Math.round(progressPercentage) 
            } 
          });
        }
      }

      if (download.status === 'failed') {
        throw new Error(`Streaming download failed for ${download.url}: ${download.error}`);
      }

      return download;
    });

    await Promise.all(completionPromises);
    sendMessage({ key: "status.streamingCompleted" });
  }

  // Add regular file downloads for non-streamed content
  if (downloadOptions.downloadAssets) {
    await addRegularFiles(data, downloadOptions, tabUrl, sendMessage, downloadId);
  }

  // Create ZIP with chunked processing
  sendMessage({ key: "status.creatingStreamingZip" });

  try {
    const zipBlob = await createZipFromDownloads(streamingDownloads, {
      progressive: true,
      compressionLevel: 6,
      maxMemoryUsage: 50 * 1024 * 1024, // 50MB limit
      enableStreaming: true,
    });

    await initiateDownload(zipBlob, zipFilename, (msg) => {
        if (typeof msg === 'string') sendMessage(msg);
        else sendMessage(msg);
    }, tabId);
    sendMessage({ key: "status.streamingSuccess" });

  } catch (error) {
    throw error;
  }
}

/**
 * Check if any files are large enough to benefit from streaming
 */
async function checkForLargeFiles(data: ReturnType<typeof getResources>): Promise<boolean> {
  const checkThreshold = 5 * 1024 * 1024; // 5MB threshold
  const allUrls = [...data.css, ...data.js, ...data.images, ...data.documents];

  for (const url of allUrls) {
    if (!url || url.startsWith("data:")) continue;

    try {
      const metadata = await streamingFetcher.getMetadata(url, { chunkTimeout: 5000 });
      if (metadata.size > checkThreshold) {
        return true;
      }
    } catch (error) {
      // If we can't determine size, conservatively assume it might be large
      const largeFileExtensions = ['.zip', '.rar', '.7z', '.tar', '.gz', '.mp4', '.avi', '.mov', '.mkv'];
      if (largeFileExtensions.some(ext => url.toLowerCase().includes(ext))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Add regular file downloads for content not handled by streaming
 */
async function addRegularFiles(
  data: ReturnType<typeof getResources>,
  downloadOptions: FilterOptions,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  downloadId: string
) {
  const zip = new JSZip();
  const storage = new JSZipAdapter(zip);

  if (downloadOptions.downloadAssets) {
    // Add CSS files that weren't streamed
    if (data.css.length > 0) {
      await addCssFiles(data.css, storage, tabUrl, sendMessage, downloadId);
    }

    // Add JS files that weren't streamed
    if (data.js.length > 0) {
      await addJsFiles(data.js, storage, tabUrl, sendMessage, downloadId);
    }
  }

  if (downloadOptions.downloadDocuments) {
    await addDocumentFiles(data.documents, storage, tabUrl, sendMessage, downloadId);
  }

  if (downloadOptions.downloadImages) {
    await addImageFiles(data.images, storage, tabUrl, sendMessage, downloadId);
  }

  if (downloadOptions.downloadLinks) {
    await addHtmlFiles(data.links, storage, tabUrl, sendMessage, downloadId);
  }

  if (downloadOptions.downloadContentAsText) {
    await addContentText(data.text, storage);
  }
}

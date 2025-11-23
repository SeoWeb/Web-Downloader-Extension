/// <reference types="chrome" />
import JSZip from "jszip";
import { getResources } from "./resources";
// import { messageActions } from "../common/message";
import {
  addIndexHtml,
  addContentText,
  addCssFiles,
  addJsFiles,
  addDocumentFiles,
  addImageFiles,
  addHtmlFiles
} from "./fileHandlers";
import { convertToSingleFileHtml } from "./htmlUtils";
import { saveBlob } from "../common/blobStorage";

// download.ts

// Manage download state using chrome.storage.local to persist across service worker restarts
const setDownloadInProgress = async (inProgress: boolean) => {
  await chrome.storage.local.set({ isDownloadInProgress: inProgress });
};

const getDownloadInProgress = async (): Promise<boolean> => {
  const result = await chrome.storage.local.get('isDownloadInProgress');
  return result.isDownloadInProgress ?? false;
};


// Add a listener to clean up object URLs after download completion
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state && delta.state.current !== 'inprogress') {
    const { downloads } = await chrome.storage.local.get('downloads');
    const downloadMap = downloads || {};

    if (downloadMap[delta.id]) {
      console.log(`Cleaning up object URL for download ${delta.id}`);
      const url = downloadMap[delta.id];
      
      // Only revoke object URLs, not data URLs or blob URLs
      if (url.startsWith('blob:') || url.startsWith('data:')) {
        try {
          // If it's a blob URL created via offscreen document, we might need to revoke it there
          // But since we can't easily tell if it was created in offscreen or here (if not SW),
          // we try to revoke it here. If it fails, we might need to send a message to offscreen.
          // However, blob URLs are origin-specific. If created in offscreen, they belong to the extension origin.
          // Revoking in background script (SW) might not work for URLs created in offscreen document?
          // Actually, URL.revokeObjectURL works for any URL associated with the document's origin.
          // But SW doesn't have access to the same URL registry as the window?
          // Let's try to revoke here, and if it's an offscreen URL, we send a message.
          
          if (typeof URL.revokeObjectURL === 'function') {
             URL.revokeObjectURL(url);
          } else {
             // Send message to offscreen to revoke
             await setupOffscreenDocument('offscreen.html');
             chrome.runtime.sendMessage({ action: 'revokeBlobUrl', url });
          }
        } catch (cleanupError) {
          console.warn(`Failed to revoke object URL for download ${delta.id}:`, cleanupError);
        }
      }
      
      delete downloadMap[delta.id];
      await chrome.storage.local.set({ downloads: downloadMap });
    }
  }
});

let creatingOffscreenDocument: Promise<void> | null = null;

async function setupOffscreenDocument(path: string) {
  // Check if offscreen API is available (permission granted)
  if (!chrome.offscreen) {
    throw new Error('Offscreen permission is required for this operation');
  }

  // Check if offscreen document already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(path)]
  });

  if (existingContexts.length > 0) {
    return;
  }

  // Create offscreen document
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
  } else {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'To create Blob URLs for large downloads',
    });
    await creatingOffscreenDocument;
    creatingOffscreenDocument = null;
  }
}


export async function downloadResources(
  html: string,
  tabUrl: string,
  downloadOptions: {
    downloadHTML: boolean;
    downloadImages: boolean;
    downloadLinks: boolean;
    downloadAssets: boolean;
    downloadContentAsText: boolean;
    downloadDocuments: boolean;
    singleFile: boolean;
  },
  sendMessage: (message: string) => void,
) {
  console.log("Starting downloadResources for URL:", tabUrl);
  
  if (!tabUrl) {
    console.error("No tab URL provided");
    sendMessage("Error: No URL provided for download");
    return;
  }
  
  // Prevent concurrent downloads
  if (await getDownloadInProgress()) {
    console.warn("Download already in progress, rejecting new request");
    sendMessage("A download is already in progress. Please wait.");
    return;
  }
  
  await setDownloadInProgress(true);
  
  try {
    // Execute the download within a try-catch-finally block
    await executeDownload(html, tabUrl, downloadOptions, sendMessage);
  } catch (error) {
    console.error("Download failed:", error);
    sendMessage(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    // Always reset the flag when done
    await setDownloadInProgress(false);
    console.log("Download process completed");
  }
}

async function executeDownload(
  html: string,
  tabUrl: string,
  downloadOptions: any,
  sendMessage: (message: string) => void,
) {

  // Check network connectivity
  try {
    const online = await new Promise<boolean>((resolve) => {
      // Simple connectivity check
      fetch('https://www.google.com/favicon.ico', {
        method: 'HEAD',
        mode: 'no-cors'
      }).then(() => resolve(true))
        .catch(() => resolve(false));
      
      // Fallback timeout
      setTimeout(() => resolve(false), 5000);
    });
    
    if (!online) {
      sendMessage("No internet connection - cannot download external resources");
      console.warn("No internet connection detected");
      // Continue with basic HTML download only
      if (!downloadOptions.downloadHTML && !downloadOptions.singleFile) {
        sendMessage("Please enable HTML download or single file mode for offline use");
        return;
      }
    }
  } catch (error) {
    console.warn("Network check failed, continuing with download:", error);
    // Continue with download but warn about potential issues
    sendMessage("Network connectivity check failed - continuing with download");
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
    .filter(part => part.length > 0) // Remove empty parts
    .join("-")
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-"); // Replace invalid characters with hyphens
  
  // Limit filename length and ensure it's not empty
  const safePath = path.length > 100 ? path.substring(0, 100) : path || "webpage";
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
    sendMessage("Creating index.html");
    await addIndexHtml(html, zip, tabUrl);
    console.log("index.html created");
    sendMessage("Index.html created");
  }

  if (downloadOptions.downloadAssets) {
    console.log("Downloading assets");
    sendMessage("Downloading CSS files");
    try {
      await addCssFiles(data.css, zip, tabUrl, sendMessage);
      console.log("CSS files downloaded:", data.css.length);
      sendMessage("CSS files downloaded");
    } catch (error) {
      console.error("Error downloading CSS files:", error);
      sendMessage("Error downloading CSS files - some may be missing");
    }

    sendMessage("Downloading JS files");
    try {
      await addJsFiles(data.js, zip, tabUrl, sendMessage);
      console.log("JS files downloaded:", data.js.length);
      sendMessage("JS files downloaded");
    } catch (error) {
      console.error("Error downloading JS files:", error);
      sendMessage("Error downloading JS files - some may be missing");
    }
  }

  if (downloadOptions.downloadDocuments) {
    console.log("Downloading documents");
    sendMessage("Downloading document files");
    await addDocumentFiles(data.documents, zip, tabUrl, sendMessage);
    console.log("Documents downloaded:", data.documents.length);
    sendMessage("Document files downloaded");
  }

  if (downloadOptions.downloadImages) {
    console.log("Downloading images");
    sendMessage("Downloading images");
    await addImageFiles(data.images, zip, tabUrl, sendMessage);
    console.log("Images downloaded:", data.images.length);
    sendMessage("Images downloaded");
  }

  if (downloadOptions.downloadLinks) {
    console.log("Downloading linked HTML files");
    sendMessage("Downloading linked html files");
    await addHtmlFiles(data.links, zip, tabUrl, sendMessage);
    console.log("Linked HTML files downloaded:", data.links.length);
    sendMessage("Linked html files downloaded");
  }

  if (downloadOptions.downloadContentAsText) {
    console.log("Downloading content as text");
    sendMessage("Downloading content as text");
    await addContentText(data.text, zip);
    console.log("Content text downloaded");
    sendMessage("Content as text downloaded");
  }

  try {
    console.log("Creating final download package");
    let blob: any;

    if (downloadOptions.singleFile) {
      sendMessage("Creating index.html");
      const singleFileHtml = await convertToSingleFileHtml(html, tabUrl);
      blob = new Blob([singleFileHtml], { type: "text/html;charset=UTF-8" });
      zipFilename = zipFilename.replace(".zip", ".html");
      console.log("Single HTML file created");
    } else {
      console.log("Generating ZIP archive");
      blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      });
      console.log("ZIP archive created");
    }

    console.log("Preparing download");
    if (!blob || blob.size === 0) {
      throw new Error("No blob data available for download or blob is empty");
    }

    // Use a more reliable approach - create object URL instead of FileReader
    const downloadWithRetry = async (attempt = 1): Promise<void> => {
      try {
        console.log(`Preparing download (attempt ${attempt}):`, zipFilename);
        
        // In service workers, we need to use data URLs directly since URL.createObjectURL is not available
        // Check if we're in a service worker context
        // We use a loose check to avoid TypeScript errors with ServiceWorkerGlobalScope
        const isServiceWorker = typeof self !== 'undefined' && self.constructor.name === 'ServiceWorkerGlobalScope';
        
        if (isServiceWorker || typeof URL.createObjectURL !== 'function') {
          console.log("Running in service worker context or URL.createObjectURL not available, using data URL directly");
          
          // For service workers, we must use data URLs directly
          if (blob.size < 50 * 1024 * 1024) { // 50MB limit for data URLs in Chrome
            // Convert blob to data URL using FileReader
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(new Error('Failed to read blob as data URL'));
              reader.readAsDataURL(blob);
            });
            
            // Use data URL directly with chrome.downloads.download
            const downloadId = await new Promise<number>((resolve, reject) => {
              chrome.downloads.download(
                {
                  url: dataUrl,
                  filename: zipFilename,
                  saveAs: true,
                  conflictAction: "uniquify",
                },
                (downloadId) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                  } else if (downloadId === undefined) {
                    reject(new Error('Download failed: No download ID assigned.'));
                  } else {
                    resolve(downloadId);
                  }
                }
              );
            });
            
            console.log("Download started with data URL, ID:", downloadId);
            sendMessage("Download started successfully");
            return;
          } else {
            console.log(`Blob too large for data URL (${blob.size} bytes). Using offscreen document.`);
            
            // Check if offscreen permission is available
            if (!chrome.offscreen) {
              const errorMsg = "Download too large (>50MB). Please enable 'Offscreen' permission in the extension settings to download large files.";
              sendMessage(errorMsg);
              throw new Error(errorMsg);
            }

            sendMessage("Large file detected, using advanced download method...");
            
            // Use offscreen document for large files
            const key = `download-${Date.now()}`;
            await saveBlob(key, blob);
            
            await setupOffscreenDocument('offscreen.html');
            
            const response = await chrome.runtime.sendMessage({
              action: 'createBlobUrl',
              key
            });
            
            if (response.error) {
              throw new Error(response.error);
            }
            
            const objectUrl = response.url;
            console.log("Created object URL via offscreen:", objectUrl);
            
            const downloadId = await new Promise<number>((resolve, reject) => {
              chrome.downloads.download(
                {
                  url: objectUrl,
                  filename: zipFilename,
                  saveAs: true,
                  conflictAction: "uniquify",
                },
                (downloadId) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                  } else if (downloadId === undefined) {
                    reject(new Error('Download failed: No download ID assigned.'));
                  } else {
                    resolve(downloadId);
                  }
                }
              );
            });
            
            console.log("Download started successfully via offscreen, ID:", downloadId);
            sendMessage("Download started successfully");

            // Store the mapping of download ID to object URL for later cleanup
            const { downloads } = await chrome.storage.local.get('downloads');
            const downloadMap = downloads || {};
            downloadMap[downloadId] = objectUrl;
            await chrome.storage.local.set({ downloads: downloadMap });
            return;
          }
        } else {
          // In non-service worker contexts, we can use object URLs
          console.log("Using object URL for download");
          const objectUrl = URL.createObjectURL(blob);
          console.log("Created object URL:", objectUrl.substring(0, 50) + "...");
          
          const downloadId = await new Promise<number>((resolve, reject) => {
            chrome.downloads.download(
              {
                url: objectUrl,
                filename: zipFilename,
                saveAs: true,
                conflictAction: "uniquify",
              },
              (downloadId) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else if (downloadId === undefined) {
                  reject(new Error('Download failed: No download ID assigned.'));
                } else {
                  resolve(downloadId);
                }
              }
            );
          });
          
          console.log("Download started successfully, ID:", downloadId);
          sendMessage("Download started successfully");

          // Store the mapping of download ID to object URL for later cleanup
          const { downloads } = await chrome.storage.local.get('downloads');
          const downloadMap = downloads || {};
          downloadMap[downloadId] = objectUrl;
          await chrome.storage.local.set({ downloads: downloadMap });
        }
      } catch (error) {
        console.warn(`Download attempt ${attempt} failed:`, error);
        
        if (attempt >= 3) {
          throw new Error(`Failed to download after 3 attempts: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        // Exponential backoff for retries
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
        return downloadWithRetry(attempt + 1);
      }
    };

    await downloadWithRetry();
    
  } catch (error) {
    console.error("Error creating download package:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to create download package";
    sendMessage(errorMessage);
    throw error; // Re-throw to allow calling code to handle the error
  }

  return data.links;
}

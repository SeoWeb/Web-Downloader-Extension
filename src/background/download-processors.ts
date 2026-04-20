
import { IStorageAdapter } from "./storage/storage-adapter";
import {
  addIndexHtml,
  addCssFiles,
  addJsFiles,
  addDocumentFiles,
  addImageFiles,
  addHtmlFiles,
} from "./fileHandlers";
import { downloadId } from "./download-state";
import { DEFAULT_MEMORY_LIMITS } from "../utils/memoryLimits";

export async function processRegularHtml(
  html: string,
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  imageFilenameMap?: Map<string, string>,
) {
  // Check HTML size before processing
  if (html.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
    sendMessage({ key: "status.htmlTooLarge" });
  }

  await addIndexHtml(html, storage, tabUrl, imageFilenameMap);
  sendMessage({ key: "status.indexCreated" });
}

export async function addIndexHtmlFromBlob(
  htmlBlob: Blob,
  storage: IStorageAdapter,
) {
  try {
    // Convert blob to array buffer and then to string
    const arrayBuffer = await htmlBlob.arrayBuffer();
    const htmlContent = new TextDecoder('utf-8').decode(arrayBuffer);
    
    // Add to storage
    await storage.addFile("index.html", htmlContent, "text/html");
    
  } catch (error) {
    throw new Error(`Failed to process HTML content: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function processAssets(
  data: { css: string[]; js: string[] },
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
) {
  if (data.css?.length) {
    sendMessage({ key: "status.downloadingCss", options: { count: data.css.length } });
    await addCssFiles(data.css, storage, tabUrl, sendMessage, downloadId);
    sendMessage({ key: "status.cssDownloaded" });
  }

  if (data.js?.length) {
    sendMessage({ key: "status.downloadingJs", options: { count: data.js.length } });
    await addJsFiles(data.js, storage, tabUrl, sendMessage, downloadId);
    sendMessage({ key: "status.jsDownloaded" });
  }
}

export async function processDocuments(
  documents: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
) {
  if (!documents?.length) return;

  sendMessage({ key: "status.downloadingDocuments", options: { count: documents.length } });
  await addDocumentFiles(documents, storage, tabUrl, sendMessage, downloadId);
  sendMessage({ key: "status.documentsDownloaded" });
}

export async function processImages(
  images: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
): Promise<Map<string, string>> {
  if (!images?.length) return new Map();

  sendMessage({ key: "status.downloadingImages", options: { count: images.length } });
  const filenameMap = await addImageFiles(images, storage, tabUrl, sendMessage, downloadId);
  sendMessage({ key: "status.imagesDownloaded" });
  return filenameMap;
}

export async function processLinks(
  links: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
) {
  if (!links?.length) return;

  sendMessage({ key: "status.downloadingLinks", options: { count: links.length } });
  await addHtmlFiles(links, storage, tabUrl, sendMessage, downloadId);
  sendMessage({ key: "status.linksDownloaded" });
}

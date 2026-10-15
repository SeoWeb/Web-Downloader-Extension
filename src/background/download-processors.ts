import { IStorageAdapter } from "./storage/server-storage-adapter";
import {
  addCssFiles,
  addJsFiles,
  addDocumentFiles,
  addImageFiles,
} from "./fileHandlers";
import { DownloadContext } from "./download-state";

/**
 * Options forwarded to the file handlers (D2 / tasks 1.5 + 3.1).
 *
 * `documentUrl` is the URL of the page the raw URLs were extracted from.
 * Handlers resolve relative URLs against it (falling back to the origin)
 * so nested pages resolve correctly. For linked pages this is the linked
 * page's own URL, which keeps the scraper's dedup filter aligned with the
 * fetchers (task 1.6).
 */
export interface HandlerOptions {
  documentUrl?: string;
}

export async function processAssets(
  data: { css: string[]; js: string[] },
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  context?: DownloadContext,
  options?: HandlerOptions,
) {
  const documentUrl = options?.documentUrl ?? tabUrl;

  if (data.css?.length) {
    sendMessage({
      key: "status.downloadingCss",
      options: { count: data.css.length },
    });
    await addCssFiles(
      data.css,
      storage,
      tabUrl,
      sendMessage,
      context?.downloadId,
      { documentUrl },
    );
    sendMessage({ key: "status.cssDownloaded" });
  }

  if (data.js?.length) {
    sendMessage({
      key: "status.downloadingJs",
      options: { count: data.js.length },
    });
    await addJsFiles(
      data.js,
      storage,
      tabUrl,
      sendMessage,
      context?.downloadId,
      { documentUrl },
    );
    sendMessage({ key: "status.jsDownloaded" });
  }
}

export async function processDocuments(
  documents: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  context?: DownloadContext,
  options?: HandlerOptions,
) {
  if (!documents?.length) return;

  const documentUrl = options?.documentUrl ?? tabUrl;

  sendMessage({
    key: "status.downloadingDocuments",
    options: { count: documents.length },
  });
  await addDocumentFiles(
    documents,
    storage,
    tabUrl,
    sendMessage,
    context?.downloadId,
    { documentUrl },
  );
  sendMessage({ key: "status.documentsDownloaded" });
}

export async function processImages(
  images: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  context?: DownloadContext,
  options?: HandlerOptions,
): Promise<Map<string, string>> {
  if (!images?.length) return new Map();

  const documentUrl = options?.documentUrl ?? tabUrl;

  sendMessage({
    key: "status.downloadingImages",
    options: { count: images.length },
  });
  const filenameMap = await addImageFiles(
    images,
    storage,
    tabUrl,
    sendMessage,
    context?.downloadId,
    { documentUrl },
  );
  sendMessage({ key: "status.imagesDownloaded" });
  return filenameMap;
}

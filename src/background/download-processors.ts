import { IStorageAdapter } from "./storage/server-storage-adapter";
import {
  addCssFiles,
  addJsFiles,
  addDocumentFiles,
  addImageFiles,
} from "./fileHandlers";
import { DownloadContext } from "./download-state";
import type { ResourceFailureTally } from "./urlUtils";

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
  /**
   * Shared accumulator for failed resource fetches. When provided, it is
   * forwarded to every handler so their failCounts land under their own
   * category key; download-core sums it for the scrape-complete signal.
   */
  failureTally?: ResourceFailureTally;
}

/**
 * Merge filename maps into ONE map for upload (fix G).
 *
 * The first map (images) is copied first; every following map's entries are
 * added only when the key is not already present — earlier categories are
 * never clobbered on the (rare) shared-URL collision. Sequential guarded
 * set loops, deliberately not spread merges.
 */
export function mergeFilenameMaps(
  primary?: Map<string, string>,
  ...others: Array<Map<string, string> | undefined>
): Map<string, string> {
  const merged = new Map<string, string>();
  for (const [key, value] of primary ?? []) {
    merged.set(key, value);
  }
  for (const source of others) {
    for (const [key, value] of source ?? []) {
      if (!merged.has(key)) merged.set(key, value);
    }
  }
  return merged;
}

/**
 * Download the page's stylesheets and scripts.
 *
 * Returns the merged filename map from both handlers (raw reference AND
 * absolute URL → archive path), mirroring processImages — the caller
 * uploads one combined map to the server (fix G).
 */
export async function processAssets(
  data: { css: string[]; js: string[] },
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  context?: DownloadContext,
  options?: HandlerOptions,
): Promise<Map<string, string>> {
  const documentUrl = options?.documentUrl ?? tabUrl;
  let cssMap: Map<string, string> | undefined;
  let jsMap: Map<string, string> | undefined;

  if (data.css?.length) {
    sendMessage({
      key: "status.downloadingCss",
      options: { count: data.css.length },
    });
    cssMap = await addCssFiles(
      data.css,
      storage,
      tabUrl,
      sendMessage,
      context?.downloadId,
      { documentUrl, failureTally: options?.failureTally },
    );
    sendMessage({ key: "status.cssDownloaded" });
  }

  if (data.js?.length) {
    sendMessage({
      key: "status.downloadingJs",
      options: { count: data.js.length },
    });
    jsMap = await addJsFiles(
      data.js,
      storage,
      tabUrl,
      sendMessage,
      context?.downloadId,
      { documentUrl, failureTally: options?.failureTally },
    );
    sendMessage({ key: "status.jsDownloaded" });
  }

  return mergeFilenameMaps(cssMap, jsMap);
}

/**
 * Download the page's document links.
 *
 * Returns the document filename map (raw attribute AND absolute URL →
 * archive path), mirroring processImages (fix G).
 */
export async function processDocuments(
  documents: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  context?: DownloadContext,
  options?: HandlerOptions,
): Promise<Map<string, string>> {
  if (!documents?.length) return new Map<string, string>();

  const documentUrl = options?.documentUrl ?? tabUrl;

  sendMessage({
    key: "status.downloadingDocuments",
    options: { count: documents.length },
  });
  const docMap = await addDocumentFiles(
    documents,
    storage,
    tabUrl,
    sendMessage,
    context?.downloadId,
    { documentUrl, failureTally: options?.failureTally },
  );
  sendMessage({ key: "status.documentsDownloaded" });
  return mergeFilenameMaps(docMap);
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
    { documentUrl, failureTally: options?.failureTally },
  );
  sendMessage({ key: "status.imagesDownloaded" });
  return filenameMap;
}

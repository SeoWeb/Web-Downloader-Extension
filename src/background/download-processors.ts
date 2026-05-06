
import { IStorageAdapter } from "./storage/server-storage-adapter";
import {
  addCssFiles,
  addJsFiles,
  addDocumentFiles,
  addImageFiles,
} from "./fileHandlers";
import { downloadId } from "./download-state";

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

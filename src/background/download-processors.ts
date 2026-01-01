
import JSZip from "jszip";
import {
  addIndexHtml,
  addCssFiles,
  addJsFiles,
  addDocumentFiles,
  addImageFiles,
  addHtmlFiles,
} from "./fileHandlers";
import { downloadId } from "./download-state";
import { formatBytes } from "./download-utils";
import { DEFAULT_MEMORY_LIMITS } from "../utils/memoryLimits";

export async function processRegularHtml(
  html: string,
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
) {
  // Check HTML size before processing
  if (html.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
    console.warn(`HTML content too large: ${formatBytes(html.length)}`);
    sendMessage({ key: "status.htmlTooLarge" });
  }

  await addIndexHtml(html, zip, tabUrl);
  console.log("index.html created");
  sendMessage({ key: "status.indexCreated" });
}

export async function addIndexHtmlFromBlob(
  htmlBlob: Blob,
  zip: JSZip,
) {
  try {
    // Convert blob to array buffer and then to string
    const arrayBuffer = await htmlBlob.arrayBuffer();
    const htmlContent = new TextDecoder('utf-8').decode(arrayBuffer);
    
    // Add to ZIP
    zip.file("index.html", htmlContent, {
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    
    console.log(`Added HTML from blob (${formatBytes(htmlBlob.size)}) to ZIP`);
  } catch (error) {
    console.error("Error adding HTML blob to ZIP:", error);
    throw new Error(`Failed to process HTML content: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function processAssets(
  data: { css: string[]; js: string[] },
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
) {
  if (data.css.length > 0) {
    sendMessage({ key: "status.downloadingCss" });
    try {
      await addCssFiles(data.css, zip, tabUrl, sendMessage, downloadId);
      console.log("CSS files downloaded:", data.css.length);
      sendMessage({ key: "status.cssDownloaded" });
    } catch (error) {
      console.error("Error downloading CSS files:", error);
      sendMessage({ key: "status.cssError" });
    }
  }

  if (data.js.length > 0) {
    sendMessage({ key: "status.downloadingJs" });
    try {
      await addJsFiles(data.js, zip, tabUrl, sendMessage, downloadId);
      console.log("JS files downloaded:", data.js.length);
      sendMessage({ key: "status.jsDownloaded" });
    } catch (error) {
      console.error("Error downloading JS files:", error);
      sendMessage({ key: "status.jsError" });
    }
  }
}

export async function processDocuments(
  documents: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
) {
  if (documents.length > 0) {
    sendMessage({ key: "status.downloadingDocuments" });
    await addDocumentFiles(documents, zip, tabUrl, sendMessage, downloadId);
    console.log("Documents downloaded:", documents.length);
    sendMessage({ key: "status.documentsDownloaded" });
  }
}

export async function processImages(
  images: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
) {
  if (images.length > 0) {
    sendMessage({ key: "status.downloadingImages" });
    await addImageFiles(images, zip, tabUrl, sendMessage, downloadId);
    console.log("Images downloaded:", images.length);
    sendMessage({ key: "status.imagesDownloaded" });
  }
}

export async function processLinks(
  links: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void
) {
  if (links.length > 0) {
    sendMessage({ key: "status.downloadingLinks" });
    await addHtmlFiles(links, zip, tabUrl, sendMessage, downloadId);
    console.log("Linked HTML files downloaded:", links.length);
    sendMessage({ key: "status.linksDownloaded" });
  }
}

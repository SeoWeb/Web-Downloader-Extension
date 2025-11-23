import JSZip from "jszip";
import { fetchUrl, fixFilename, FetchOptions } from "./urlUtils";
import { convertHtml } from "./htmlUtils";
import { memoryManager } from "../utils/MemoryManager";
import { DEFAULT_MEMORY_LIMITS } from "../utils/memoryLimits";

export async function addIndexHtml(
  inputHtml: string,
  zip: JSZip,
  tabUrl: string,
) {
  try {
    const html = convertHtml(inputHtml, tabUrl);
    const blob = new Blob([html], { type: "text/html" });
    zip.file("index.html", blob);
  } catch (error) {
    console.error("Error creating index.html:", error);
    throw new Error("Failed to create index.html");
  }
}

export async function addContentText(text: string, zip: JSZip) {
  try {
    const blob = new Blob([text], { type: "text/plain" });
    zip.file("content.txt", blob);
  } catch (error) {
    console.error("Error creating content.txt:", error);
    throw new Error("Failed to create content.txt");
  }
}

export async function addCssFiles(
  csss: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
) {
  if (!csss?.length) return;

  const zstyles = zip.folder("styles") || zip;
  const count = csss.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  // Get optimal concurrency based on memory pressure
  const maxConcurrency = memoryManager.getOptimalConcurrency();
  const semaphore = new Semaphore(maxConcurrency);
  const downloadPromises: Promise<void>[] = [];

  for (let i = 0; i < count; i++) {
    const css = csss[i];

    if (!css) {
      failCount++;
      continue;
    }

    // Create download promise with semaphore control
    const downloadPromise = semaphore.acquire().then(async (release) => {
      try {
        sendMessage(`Downloading CSS files: ${i + 1}/${count}`);

        const u = new URL(css.startsWith("http") ? css : tabUrl);
        const baseUrl = u.origin;

        // Create unique request ID for tracking
        const requestId = `css-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Queue the resource with memory manager
        memoryManager.queueResource({
          id: requestId,
          url: css,
          type: "CSS",
          size: 0, // Will be updated when we get Content-Length
          status: "pending",
        });

        const response = await fetchUrl(css, baseUrl, {
          downloadId,
          checkSize: true,
        } as FetchOptions);

        if (!response) {
          console.warn(`Failed to fetch CSS: ${css}`);
          sendMessage(`Failed to download CSS: ${css}`);
          memoryManager.markResourceFailed(requestId);
          failCount++;
          return;
        }

        // Get actual size from response
        const contentLength =
          response.headers.get("X-Actual-Size") ||
          response.headers.get("Content-Length") ||
          "0";
        const actualSize = parseInt(contentLength) || 0;

        // Track memory allocation
        memoryManager.trackResourceAllocation(requestId, actualSize);

        const cssContent = await response.text();

        // Check CSS content size against limits
        if (cssContent.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
          console.warn(
            `CSS content too large: ${css} (${cssContent.length} bytes)`,
          );
          sendMessage(`Skipping CSS due to size limit: ${css}`);
          memoryManager.releaseResource(requestId);
          skippedCount++;
          return;
        }

        // Extract background images from CSS content
        const backgroundImages = extractBackgroundImagesFromCSS(cssContent);

        // Download background images with memory management
        if (backgroundImages.length > 0) {
          await downloadBackgroundImages(
            backgroundImages,
            zip,
            baseUrl,
            sendMessage,
            downloadId,
          );
        }

        // Convert background image URLs to relative paths in CSS
        const updatedCssContent = convertBackgroundImageUrlsToRelative(
          cssContent,
          baseUrl,
          "../",
        );

        const blob = new Blob([updatedCssContent], { type: "text/css" });
        const filename = new URL(css, baseUrl).pathname.split("/").pop();
        if (!filename) {
          console.warn(`Could not determine filename for CSS: ${css}`);
          sendMessage(`Could not determine filename for: ${css}`);
          memoryManager.releaseResource(requestId);
          failCount++;
          return;
        }

        zstyles.file(fixFilename(filename), blob);
        successCount++;

        // Release memory
        memoryManager.releaseResource(requestId);
      } catch (error) {
        console.error(`Error downloading CSS ${css}:`, error);
        sendMessage(`Error downloading CSS: ${css}`);
        failCount++;
      } finally {
        release();
      }
    });

    downloadPromises.push(downloadPromise);
  }

  // Wait for all downloads to complete
  await Promise.allSettled(downloadPromises);

  console.log(
    `CSS download summary: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
  );
  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      `CSS files downloaded: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
    );
  }
}

// Helper function to extract background images from CSS content
function extractBackgroundImagesFromCSS(cssContent: string): string[] {
  const imageUrls: string[] = [];

  // Regular expression to match url() patterns in CSS
  const urlPattern = /url\(['"]?(.*?)['"]?\)/g;
  let match;

  while ((match = urlPattern.exec(cssContent)) !== null) {
    const imageUrl = match[1].trim();
    if (imageUrl && !imageUrl.startsWith("data:")) {
      imageUrls.push(imageUrl);
    }
  }

  return imageUrls;
}

// Helper function to download background images found in CSS
async function downloadBackgroundImages(
  imageUrls: string[],
  zip: JSZip,
  baseUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
): Promise<void> {
  const zimages = zip.folder("images") || zip;
  const count = imageUrls.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  // Get optimal concurrency based on memory pressure
  const maxConcurrency = Math.max(
    1,
    Math.floor(memoryManager.getOptimalConcurrency() * 0.5),
  ); // Lower concurrency for images
  const semaphore = new Semaphore(maxConcurrency);
  const downloadPromises: Promise<void>[] = [];

  for (let i = 0; i < count; i++) {
    const imageUrl = imageUrls[i];

    if (!imageUrl) {
      failCount++;
      continue;
    }

    const downloadPromise = semaphore.acquire().then(async (release) => {
      try {
        sendMessage(
          `Downloading background images from CSS: ${i + 1}/${count}`,
        );

        const requestId = `img-bg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        memoryManager.queueResource({
          id: requestId,
          url: imageUrl,
          type: "IMAGE",
          size: 0,
          status: "pending",
        });

        const response = await fetchUrl(imageUrl, baseUrl, {
          downloadId,
          checkSize: true,
        } as FetchOptions);

        if (!response) {
          console.warn(`Failed to fetch background image: ${imageUrl}`);
          sendMessage(`Failed to download background image: ${imageUrl}`);
          memoryManager.markResourceFailed(requestId);
          failCount++;
          return;
        }

        const contentLength =
          response.headers.get("X-Actual-Size") ||
          response.headers.get("Content-Length") ||
          "0";
        const actualSize = parseInt(contentLength) || 0;

        memoryManager.trackResourceAllocation(requestId, actualSize);

        const blob = await response.blob();
        const filename = new URL(imageUrl, baseUrl).pathname.split("/").pop();
        if (!filename) {
          console.warn(
            `Could not determine filename for background image: ${imageUrl}`,
          );
          sendMessage(`Could not determine filename for: ${imageUrl}`);
          memoryManager.releaseResource(requestId);
          failCount++;
          return;
        }

        zimages.file(fixFilename(filename), blob);
        successCount++;

        memoryManager.releaseResource(requestId);
      } catch (error) {
        console.error(`Error downloading background image ${imageUrl}:`, error);
        sendMessage(`Error downloading background image: ${imageUrl}`);
        failCount++;
      } finally {
        release();
      }
    });

    downloadPromises.push(downloadPromise);
  }

  await Promise.allSettled(downloadPromises);

  console.log(
    `Background images from CSS download summary: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
  );
  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      `Background images from CSS downloaded: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
    );
  }
}

// Helper function to convert background image URLs to relative paths in CSS
function convertBackgroundImageUrlsToRelative(
  cssContent: string,
  baseUrl: string,
  path: string = "./",
): string {
  // Regular expression to match url() patterns in CSS
  const urlPattern = /url\(['"]?(.*?)['"]?\)/gi;
  let updatedContent = cssContent;

  // Replace all image URLs with relative paths
  updatedContent = updatedContent.replace(urlPattern, (match, imageUrl) => {
    if (!imageUrl || imageUrl.startsWith("data:")) {
      return match; // Skip data URLs
    }

    try {
      // If URL is already relative, preserve its structure but ensure it points to images folder
      if (!imageUrl.startsWith("http")) {
        const filename = imageUrl.split("/").pop();
        if (filename) {
          const relativeImagePath = path + "images/" + filename;
          return match.replace(imageUrl, relativeImagePath);
        }
      }

      if (imageUrl.startsWith(baseUrl)) {
        const url = new URL(imageUrl, baseUrl);
        const relativePath = url.pathname;
        const filename = relativePath.split("/").pop();
        if (filename) {
          const relativeImagePath = path + "images/" + filename;
          return match.replace(imageUrl, relativeImagePath);
        }
      }
    } catch (error) {
      console.warn(
        `Failed to convert image URL to relative: ${imageUrl}`,
        error,
      );
    }

    return match; // Return original if conversion fails
  });

  return updatedContent;
}

export async function addJsFiles(
  jss: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
) {
  if (!jss?.length) return;

  const zscripts = zip.folder("scripts") || zip;
  const count = jss.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  const maxConcurrency = memoryManager.getOptimalConcurrency();
  const semaphore = new Semaphore(maxConcurrency);
  const downloadPromises: Promise<void>[] = [];

  for (let i = 0; i < count; i++) {
    const js = jss[i];

    if (!js) {
      failCount++;
      continue;
    }

    const downloadPromise = semaphore.acquire().then(async (release) => {
      try {
        sendMessage(`Downloading JS files: ${i + 1}/${count}`);

        const u = new URL(js.startsWith("http") ? js : tabUrl);
        const baseUrl = u.origin;

        const requestId = `js-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        memoryManager.queueResource({
          id: requestId,
          url: js,
          type: "JS",
          size: 0,
          status: "pending",
        });

        const response = await fetchUrl(js, baseUrl, {
          downloadId,
          checkSize: true,
        } as FetchOptions);

        if (!response) {
          console.warn(`Failed to fetch JS: ${js}`);
          sendMessage(`Failed to download JS: ${js}`);
          memoryManager.markResourceFailed(requestId);
          failCount++;
          return;
        }

        const contentLength =
          response.headers.get("X-Actual-Size") ||
          response.headers.get("Content-Length") ||
          "0";
        const actualSize = parseInt(contentLength) || 0;

        memoryManager.trackResourceAllocation(requestId, actualSize);

        const blob = await response.blob();
        const filename = new URL(js, baseUrl).pathname.split("/").pop();
        if (!filename) {
          console.warn(`Could not determine filename for JS: ${js}`);
          sendMessage(`Could not determine filename for: ${js}`);
          memoryManager.releaseResource(requestId);
          failCount++;
          return;
        }

        zscripts.file(fixFilename(filename), blob);
        successCount++;

        memoryManager.releaseResource(requestId);
      } catch (error) {
        console.error(`Error downloading JS ${js}:`, error);
        sendMessage(`Error downloading JS: ${js}`);
        failCount++;
      } finally {
        release();
      }
    });

    downloadPromises.push(downloadPromise);
  }

  await Promise.allSettled(downloadPromises);

  console.log(
    `JS download summary: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
  );
  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      `JS files downloaded: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
    );
  }
}

export async function addDocumentFiles(
  documents: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
) {
  if (!documents?.length) {
    return;
  }

  const zdocuments = zip.folder("documents") || zip;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  const count = documents.length;

  const maxConcurrency = Math.max(
    1,
    Math.floor(memoryManager.getOptimalConcurrency() * 0.7),
  ); // Moderate concurrency for documents
  const semaphore = new Semaphore(maxConcurrency);
  const downloadPromises: Promise<void>[] = [];

  for (let i = 0; i < count; i++) {
    const document = documents[i];

    if (!document) {
      failCount++;
      continue;
    }

    const downloadPromise = semaphore.acquire().then(async (release) => {
      try {
        sendMessage(`Downloading document files: ${i + 1}/${count}`);

        const u = new URL(document.startsWith("http") ? document : tabUrl);
        const baseUrl = u.origin;

        const requestId = `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        memoryManager.queueResource({
          id: requestId,
          url: document,
          type: "PDF", // Default to PDF size limits
          size: 0,
          status: "pending",
        });

        const response = await fetchUrl(document, baseUrl, {
          downloadId,
          checkSize: true,
        } as FetchOptions);

        if (!response) {
          console.error(`Failed to fetch document: ${document}`);
          sendMessage(`Failed to download document: ${document}`);
          memoryManager.markResourceFailed(requestId);
          failCount++;
          return;
        }

        const contentLength =
          response.headers.get("X-Actual-Size") ||
          response.headers.get("Content-Length") ||
          "0";
        const actualSize = parseInt(contentLength) || 0;

        memoryManager.trackResourceAllocation(requestId, actualSize);

        const blob = await response.blob();
        const filename = new URL(document, baseUrl).pathname.split("/").pop();
        if (!filename) {
          console.error(
            `Could not determine filename for document: ${document}`,
          );
          sendMessage(`Could not determine filename for: ${document}`);
          memoryManager.releaseResource(requestId);
          failCount++;
          return;
        }

        zdocuments.file(fixFilename(filename), blob);
        successCount++;

        memoryManager.releaseResource(requestId);
      } catch (error) {
        console.error(`Error downloading document ${document}:`, error);
        sendMessage(`Error downloading document: ${document}`);
        failCount++;
      } finally {
        release();
      }
    });

    downloadPromises.push(downloadPromise);
  }

  await Promise.allSettled(downloadPromises);

  console.log(
    `Document download summary: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
  );
  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      `Document files downloaded: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
    );
  }
}

export async function addImageFiles(
  images: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
) {
  if (!images?.length) return;

  const zimages = zip.folder("images") || zip;
  const count = images.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  // Lower concurrency for images since they can be large
  const maxConcurrency = Math.max(
    1,
    Math.floor(memoryManager.getOptimalConcurrency() * 0.4),
  );
  const semaphore = new Semaphore(maxConcurrency);
  const downloadPromises: Promise<void>[] = [];

  for (let i = 0; i < count; i++) {
    const image = images[i];

    if (!image) {
      failCount++;
      continue;
    }

    if (image.startsWith("data:")) {
      successCount++;
      continue;
    }

    const downloadPromise = semaphore.acquire().then(async (release) => {
      try {
        sendMessage(`Downloading images: ${i + 1}/${count}`);

        const u = new URL(image.startsWith("http") ? image : tabUrl);
        const baseUrl = u.origin;

        const requestId = `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        memoryManager.queueResource({
          id: requestId,
          url: image,
          type: "IMAGE",
          size: 0,
          status: "pending",
        });

        const response = await fetchUrl(image, baseUrl, {
          downloadId,
          checkSize: true,
        } as FetchOptions);

        if (!response) {
          console.warn(`Failed to fetch image: ${image}`);
          sendMessage(`Failed to download image: ${image}`);
          memoryManager.markResourceFailed(requestId);
          failCount++;
          return;
        }

        const contentLength =
          response.headers.get("X-Actual-Size") ||
          response.headers.get("Content-Length") ||
          "0";
        const actualSize = parseInt(contentLength) || 0;

        memoryManager.trackResourceAllocation(requestId, actualSize);

        const blob = await response.blob();
        const filename = new URL(image, baseUrl).pathname.split("/").pop();
        if (!filename) {
          console.warn(`Could not determine filename for image: ${image}`);
          sendMessage(`Could not determine filename for: ${image}`);
          memoryManager.releaseResource(requestId);
          failCount++;
          return;
        }

        zimages.file(fixFilename(filename), blob);
        successCount++;

        memoryManager.releaseResource(requestId);
      } catch (error) {
        console.error(`Error downloading image ${image}:`, error);
        sendMessage(`Error downloading image: ${image}`);
        failCount++;
      } finally {
        release();
      }
    });

    downloadPromises.push(downloadPromise);
  }

  await Promise.allSettled(downloadPromises);

  console.log(
    `Image download summary: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
  );
  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      `Images downloaded: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
    );
  }
}

export async function addHtmlFiles(
  links: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
) {
  if (!links?.length) return;

  const zhtmls = zip.folder("html") || zip;
  const count = links.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  // Get optimal concurrency based on memory pressure
  const maxConcurrency = memoryManager.getOptimalConcurrency();
  const semaphore = new Semaphore(maxConcurrency);
  const downloadPromises: Promise<void>[] = [];

  for (let i = 0; i < count; i++) {
    const link = links[i];

    if (!link) {
      failCount++;
      continue;
    }

    const downloadPromise = semaphore.acquire().then(async (release) => {
      try {
        sendMessage(`Downloading linked html files: ${i + 1}/${count}`);

        const u = new URL(tabUrl);
        const baseUrl = u.origin;

        // Create unique request ID for tracking
        const requestId = `html-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        memoryManager.queueResource({
          id: requestId,
          url: link,
          type: "HTML",
          size: 0,
          status: "pending",
        });

        const response = await fetchUrl(link, baseUrl, {
          downloadId,
          checkSize: true,
        } as FetchOptions);

        if (!response) {
          console.warn(`Failed to fetch HTML: ${link}`);
          sendMessage(`Failed to download HTML: ${link}`);
          memoryManager.markResourceFailed(requestId);
          failCount++;
          return;
        }

        const contentLength =
          response.headers.get("X-Actual-Size") ||
          response.headers.get("Content-Length") ||
          "0";
        const actualSize = parseInt(contentLength) || 0;

        memoryManager.trackResourceAllocation(requestId, actualSize);

        const inputHtml = await response.text();

        // Check HTML content size
        if (inputHtml.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
          console.warn(
            `HTML content too large: ${link} (${inputHtml.length} bytes)`,
          );
          sendMessage(`Skipping HTML due to size limit: ${link}`);
          memoryManager.releaseResource(requestId);
          skippedCount++;
          return;
        }

        const html = convertHtml(inputHtml, tabUrl, "../");
        const filename = new URL(link, baseUrl).pathname.split("/").pop();
        if (!filename?.length) {
          console.warn(`Could not determine filename for HTML: ${link}`);
          sendMessage(`Could not determine filename for: ${link}`);
          memoryManager.releaseResource(requestId);
          failCount++;
          return;
        }

        zhtmls.file(
          fixFilename(
            filename.endsWith(".html") ? filename : `${filename}.html`,
          ),
          html,
        );
        successCount++;

        memoryManager.releaseResource(requestId);
      } catch (error) {
        console.error(`Error downloading HTML ${link}:`, error);
        sendMessage(`Error downloading HTML: ${link}`);
        failCount++;
      } finally {
        release();
      }
    });

    downloadPromises.push(downloadPromise);
  }

  await Promise.allSettled(downloadPromises);

  console.log(
    `HTML download summary: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
  );
  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      `HTML files downloaded: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`,
    );
  }
}

/**
 * Simple semaphore implementation for controlling concurrent operations
 */
class Semaphore {
  private permits: number;
  private waitQueue: Array<(permit: () => void) => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  public acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.permits > 0) {
        this.permits--;
        resolve(() => this.release());
      } else {
        this.waitQueue.push(resolve);
      }
    });
  }

  private release(): void {
    if (this.waitQueue.length > 0) {
      const resolve = this.waitQueue.shift()!;
      resolve(() => this.release());
    } else {
      this.permits++;
    }
  }
}

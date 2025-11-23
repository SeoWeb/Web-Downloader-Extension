import JSZip from "jszip";
import { fetchUrl, fixFilename } from "./urlUtils";
import { convertHtml } from "./htmlUtils";
import { DEFAULT_MEMORY_LIMITS } from "../utils/memoryLimits";

// Queue system imports
import { requestQueue } from "../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../types/queue";

// Streaming imports
import { StreamingDownloader } from "../utils/StreamingDownloader";
import { ChunkedZipProcessor } from "../utils/chunkedZip";
import { StreamingFetcher } from "../utils/streamingFetch";
import { createProgressPersistence } from "../utils/progressPersistence";

// Global streaming instances
let streamingDownloader: StreamingDownloader | null = null;
let streamingFetcher: StreamingFetcher | null = null;

// Initialize streaming services
function getStreamingServices() {
  if (!streamingDownloader || !streamingFetcher) {
    const persistence = createProgressPersistence('memory'); // Use memory persistence for handlers
    streamingDownloader = new StreamingDownloader(persistence);
    streamingFetcher = new StreamingFetcher();
  }
  return { streamingDownloader, streamingFetcher };
}

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
  let completedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing CSS files for download: ${downloadId}`);
  }

  // Set up queue event listeners for this batch
  const originalListeners = requestQueue.getEventListeners() || {};
  
  const batchListeners = {
    ...originalListeners,
    onComplete: (result: any) => {
      completedCount++;
      sendMessage(`CSS files progress: ${completedCount}/${count}`);
      // Call original listener if it exists
      if (originalListeners.onComplete) {
        originalListeners.onComplete(result);
      }
    },
    onError: (request: any, error: Error) => {
      failCount++;
      console.error(`CSS download failed: ${request.url}`, error);
      // Call original listener if it exists
      if (originalListeners.onError) {
        originalListeners.onError(request, error);
      }
    }
  };

  requestQueue.setEventListeners(batchListeners);

  // Enqueue all CSS files
  const requestPromises: Promise<string>[] = [];
  
  for (let i = 0; i < count; i++) {
    const css = csss[i];
    
    if (!css) {
      failCount++;
      continue;
    }

    const fullCssUrl = new URL(css, tabUrl).href;
    const u = new URL(fullCssUrl);
    const baseUrl = u.origin;

    // Create a promise that resolves when the CSS is processed
    const cssPromise = new Promise<string>(async (resolve, reject) => {
      await requestQueue.enqueue({
        url: fullCssUrl,
        resourceType: ResourceType.CSS,
        priority: RequestPriority.HIGH, // CSS is high priority for rendering
        domain: '', // Will be auto-extracted
        dependencies: [], // No dependencies for CSS files
        retryCount: 0,
        estimatedSize: 0, // Unknown size
        fetchOptions: {
          headers: {
            'Accept': 'text/css,*/*;q=0.1',
            'Cache-Control': 'max-age=0',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          retries: 5, // Increase retries for CSS files
          timeout: 45000, // Increase timeout for CSS files
        },
        onComplete: async (result) => {
          try {
            // Check for opaque response (CORS issue)
            if (result.response.type === 'opaque') {
              console.warn(`CSS ${css} returned opaque response (CORS blocked), skipping`);
              skippedCount++;
              resolve(css);
              return;
            }

            // Get CSS content
            const cssContent = await result.response.text();

            // Check CSS content size against limits
            if (cssContent.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
              console.warn(
                `CSS content too large: ${css} (${cssContent.length} bytes)`,
              );
              skippedCount++;
              resolve(css);
              return;
            }

            // Extract background images from CSS content
            const backgroundImages = extractBackgroundImagesFromCSS(cssContent);

            // Download background images with memory management
            if (backgroundImages.length > 0) {
              await downloadBackgroundImages(
                backgroundImages,
                zip,
                fullCssUrl,
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
            const filename = new URL(fullCssUrl).pathname.split("/").pop();
            if (!filename) {
              console.warn(`Could not determine filename for CSS: ${fullCssUrl}`);
              failCount++;
              resolve(css);
              return;
            }

            zstyles.file(fixFilename(filename), blob);
            successCount++;
            resolve(css);
          } catch (error) {
            console.error(`Error processing CSS ${css}:`, error);
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
          console.error(`Error downloading CSS ${css}:`, error);
          reject(error);
        },
      });
    });

    requestPromises.push(cssPromise);
  }

  // Wait for all CSS files to be processed
  const results = await Promise.allSettled(requestPromises);
  
  // Restore original listeners
  if (originalListeners) {
    requestQueue.setEventListeners(originalListeners);
  }

  // Count failures from rejected promises
  results.forEach((result) => {
    if (result.status === 'rejected') {
      failCount++;
    }
  });

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
  let completedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing background images for download: ${downloadId}`);
  }

  // Set up queue event listeners for this batch
  const originalListeners = requestQueue.getEventListeners() || {};
  
  const batchListeners = {
    ...originalListeners,
    onComplete: (result: any) => {
      completedCount++;
      sendMessage(`Background images progress: ${completedCount}/${count}`);
      // Call original listener if it exists
      if (originalListeners.onComplete) {
        originalListeners.onComplete(result);
      }
    },
    onError: (request: any, error: Error) => {
      failCount++;
      console.error(`Background image download failed: ${request.url}`, error);
      // Call original listener if it exists
      if (originalListeners.onError) {
        originalListeners.onError(request, error);
      }
    }
  };

  requestQueue.setEventListeners(batchListeners);

  // Enqueue all background image files
  const requestPromises: Promise<string>[] = [];
  
  for (let i = 0; i < count; i++) {
    const imageUrl = imageUrls[i];

    if (!imageUrl) {
      failCount++;
      continue;
    }

    // Create a promise that resolves when the image is processed
    const imagePromise = new Promise<string>(async (resolve, reject) => {
      const fullImageUrl = new URL(imageUrl, baseUrl).href;
      await requestQueue.enqueue({
        url: fullImageUrl,
        resourceType: ResourceType.IMAGE,
        priority: RequestPriority.LOW, // Background images are low priority
        domain: '', // Will be auto-extracted
        dependencies: [], // No dependencies for images
        retryCount: 0,
        estimatedSize: 0, // Unknown size
        fetchOptions: {
          headers: {
            'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
        },
        onComplete: async (result) => {
          try {
            const blob = await result.response.blob();
            const filename = new URL(fullImageUrl).pathname.split("/").pop();
            if (!filename) {
              console.warn(
                `Could not determine filename for background image: ${fullImageUrl}`,
              );
              sendMessage(`Could not determine filename for: ${imageUrl}`);
              failCount++;
              resolve(imageUrl);
              return;
            }

            zimages.file(fixFilename(filename), blob);
            successCount++;
            resolve(imageUrl);
          } catch (error) {
            console.error(`Error processing background image ${imageUrl}:`, error);
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
          console.error(`Error downloading background image ${imageUrl}:`, error);
          reject(error);
        },
      });
    });

    requestPromises.push(imagePromise);
  }

  // Wait for all background image files to be processed
  const results = await Promise.allSettled(requestPromises);
  
  // Restore original listeners
  if (originalListeners) {
    requestQueue.setEventListeners(originalListeners);
  }

  // Count failures from rejected promises
  results.forEach((result) => {
    if (result.status === 'rejected') {
      failCount++;
    }
  });

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
  let completedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing JS files for download: ${downloadId}`);
  }

  // Set up queue event listeners for this batch
  const originalListeners = requestQueue.getEventListeners() || {};
  
  const batchListeners = {
    ...originalListeners,
    onComplete: (result: any) => {
      completedCount++;
      sendMessage(`JS files progress: ${completedCount}/${count}`);
      // Call original listener if it exists
      if (originalListeners.onComplete) {
        originalListeners.onComplete(result);
      }
    },
    onError: (request: any, error: Error) => {
      failCount++;
      console.error(`JS download failed: ${request.url}`, error);
      // Call original listener if it exists
      if (originalListeners.onError) {
        originalListeners.onError(request, error);
      }
    }
  };

  requestQueue.setEventListeners(batchListeners);

  // Enqueue all JS files
  const requestPromises: Promise<string>[] = [];
  
  for (let i = 0; i < count; i++) {
    const js = jss[i];
    
    if (!js) {
      failCount++;
      continue;
    }

    const fullJsUrl = new URL(js, tabUrl).href;
    const u = new URL(fullJsUrl);
    const baseUrl = u.origin;

    // Create a promise that resolves when the JS is processed
    const jsPromise = new Promise<string>(async (resolve, reject) => {
      await requestQueue.enqueue({
        url: fullJsUrl,
        resourceType: ResourceType.JS,
        priority: RequestPriority.NORMAL, // JS is normal priority
        domain: '', // Will be auto-extracted
        dependencies: [], // No dependencies for JS files
        retryCount: 0,
        estimatedSize: 0, // Unknown size
        fetchOptions: {
          headers: {
            'Accept': 'application/javascript,text/javascript,*/*;q=0.1',
          },
        },
        onComplete: async (result) => {
          try {
            const blob = await result.response.blob();
            const filename = new URL(fullJsUrl, baseUrl).pathname.split("/").pop();
            if (!filename) {
              console.warn(`Could not determine filename for JS: ${fullJsUrl}`);
              failCount++;
              resolve(js);
              return;
            }

            zscripts.file(fixFilename(filename), blob);
            successCount++;
            resolve(js);
          } catch (error) {
            console.error(`Error processing JS ${js}:`, error);
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
          console.error(`Error downloading JS ${js}:`, error);
          reject(error);
        },
      });
    });

    requestPromises.push(jsPromise);
  }

  // Wait for all JS files to be processed
  const results = await Promise.allSettled(requestPromises);
  
  // Restore original listeners
  if (originalListeners) {
    requestQueue.setEventListeners(originalListeners);
  }

  // Count failures from rejected promises
  results.forEach((result) => {
    if (result.status === 'rejected') {
      failCount++;
    }
  });

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
  let completedCount = 0;
  const count = documents.length;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing document files for download: ${downloadId}`);
  }

  // Set up queue event listeners for this batch
  const originalListeners = requestQueue.getEventListeners() || {};
  
  const batchListeners = {
    ...originalListeners,
    onComplete: (result: any) => {
      completedCount++;
      sendMessage(`Document files progress: ${completedCount}/${count}`);
      // Call original listener if it exists
      if (originalListeners.onComplete) {
        originalListeners.onComplete(result);
      }
    },
    onError: (request: any, error: Error) => {
      failCount++;
      console.error(`Document download failed: ${request.url}`, error);
      // Call original listener if it exists
      if (originalListeners.onError) {
        originalListeners.onError(request, error);
      }
    }
  };

  requestQueue.setEventListeners(batchListeners);

  // Enqueue all document files
  const requestPromises: Promise<string>[] = [];
  
  for (let i = 0; i < count; i++) {
    const document = documents[i];

    if (!document) {
      failCount++;
      continue;
    }

    const fullDocumentUrl = new URL(document, tabUrl).href;
    const u = new URL(fullDocumentUrl);
    const baseUrl = u.origin;

    // Create a promise that resolves when the document is processed
    const documentPromise = new Promise<string>(async (resolve, reject) => {
      await requestQueue.enqueue({
        url: fullDocumentUrl,
        resourceType: ResourceType.DOCUMENT,
        priority: RequestPriority.NORMAL, // Documents are normal priority
        domain: '', // Will be auto-extracted
        dependencies: [], // No dependencies for documents
        retryCount: 0,
        estimatedSize: 0, // Unknown size
        fetchOptions: {
          headers: {
            'Accept': 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.5',
          },
        },
        onComplete: async (result) => {
          try {
            const blob = await result.response.blob();
            const filename = new URL(fullDocumentUrl, baseUrl).pathname.split("/").pop();
            if (!filename) {
              console.error(
                `Could not determine filename for document: ${fullDocumentUrl}`,
              );
              failCount++;
              resolve(document);
              return;
            }

            zdocuments.file(fixFilename(filename), blob);
            successCount++;
            resolve(document);
          } catch (error) {
            console.error(`Error processing document ${document}:`, error);
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
          console.error(`Error downloading document ${document}:`, error);
          reject(error);
        },
      });
    });

    requestPromises.push(documentPromise);
  }

  // Wait for all document files to be processed
  const results = await Promise.allSettled(requestPromises);
  
  // Restore original listeners
  if (originalListeners) {
    requestQueue.setEventListeners(originalListeners);
  }

  // Count failures from rejected promises
  results.forEach((result) => {
    if (result.status === 'rejected') {
      failCount++;
    }
  });

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
  let completedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing image files for download: ${downloadId}`);
  }

  // Set up queue event listeners for this batch
  const originalListeners = requestQueue.getEventListeners() || {};
  
  const batchListeners = {
    ...originalListeners,
    onComplete: (result: any) => {
      completedCount++;
      sendMessage(`Images progress: ${completedCount}/${count}`);
      // Call original listener if it exists
      if (originalListeners.onComplete) {
        originalListeners.onComplete(result);
      }
    },
    onError: (request: any, error: Error) => {
      failCount++;
      console.error(`Image download failed: ${request.url}`, error);
      // Call original listener if it exists
      if (originalListeners.onError) {
        originalListeners.onError(request, error);
      }
    }
  };

  requestQueue.setEventListeners(batchListeners);

  // Enqueue all image files
  const requestPromises: Promise<string>[] = [];
  
  for (let i = 0; i < count; i++) {
    const image = images[i];

    if (!image) {
      failCount++;
      continue;
    }

    if (image.startsWith("data:")) {
      successCount++;
      skippedCount++;
      continue;
    }

    const fullImageUrl = new URL(image, tabUrl).href;
    const u = new URL(fullImageUrl);
    const baseUrl = u.origin;

    // Create a promise that resolves when the image is processed
    const imagePromise = new Promise<string>(async (resolve, reject) => {
      await requestQueue.enqueue({
        url: fullImageUrl,
        resourceType: ResourceType.IMAGE,
        priority: RequestPriority.LOW, // Images are low priority
        domain: '', // Will be auto-extracted
        dependencies: [], // No dependencies for images
        retryCount: 0,
        estimatedSize: 0, // Unknown size
        fetchOptions: {
          headers: {
            'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
        },
        onComplete: async (result) => {
          try {
            const blob = await result.response.blob();
            const filename = new URL(fullImageUrl, baseUrl).pathname.split("/").pop();
            if (!filename) {
              console.warn(`Could not determine filename for image: ${fullImageUrl}`);
              failCount++;
              resolve(image);
              return;
            }

            zimages.file(fixFilename(filename), blob);
            successCount++;
            resolve(image);
          } catch (error) {
            console.error(`Error processing image ${image}:`, error);
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
          console.error(`Error downloading image ${image}:`, error);
          reject(error);
        },
      });
    });

    requestPromises.push(imagePromise);
  }

  // Wait for all image files to be processed
  const results = await Promise.allSettled(requestPromises);
  
  // Restore original listeners
  if (originalListeners) {
    requestQueue.setEventListeners(originalListeners);
  }

  // Count failures from rejected promises
  results.forEach((result) => {
    if (result.status === 'rejected') {
      failCount++;
    }
  });

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
  let completedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing HTML files for download: ${downloadId}`);
  }

  // Set up queue event listeners for this batch
  const originalListeners = requestQueue.getEventListeners() || {};
  
  const batchListeners = {
    ...originalListeners,
    onComplete: (result: any) => {
      completedCount++;
      sendMessage(`HTML files progress: ${completedCount}/${count}`);
      // Call original listener if it exists
      if (originalListeners.onComplete) {
        originalListeners.onComplete(result);
      }
    },
    onError: (request: any, error: Error) => {
      failCount++;
      console.error(`HTML download failed: ${request.url}`, error);
      // Call original listener if it exists
      if (originalListeners.onError) {
        originalListeners.onError(request, error);
      }
    }
  };

  requestQueue.setEventListeners(batchListeners);

  // Enqueue all HTML files
  const requestPromises: Promise<string>[] = [];
  
  for (let i = 0; i < count; i++) {
    const link = links[i];

    if (!link) {
      failCount++;
      continue;
    }

    const fullHtmlUrl = new URL(link, tabUrl).href;
    const u = new URL(fullHtmlUrl);
    const baseUrl = u.origin;

    // Create a promise that resolves when the HTML is processed
    const htmlPromise = new Promise<string>(async (resolve, reject) => {
      await requestQueue.enqueue({
        url: fullHtmlUrl,
        resourceType: ResourceType.HTML,
        priority: RequestPriority.CRITICAL, // HTML is critical priority
        domain: '', // Will be auto-extracted
        dependencies: [], // No dependencies for HTML files
        retryCount: 0,
        estimatedSize: 0, // Unknown size
        fetchOptions: {
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          },
        },
        onComplete: async (result) => {
          try {
            const inputHtml = await result.response.text();

            // Check HTML content size
            if (inputHtml.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
              console.warn(
                `HTML content too large: ${link} (${inputHtml.length} bytes)`,
              );
              sendMessage(`Skipping HTML due to size limit: ${link}`);
              skippedCount++;
              resolve(link);
              return;
            }

            const html = convertHtml(inputHtml, tabUrl, "../");
            const filename = new URL(fullHtmlUrl, baseUrl).pathname.split("/").pop();
            if (!filename?.length) {
              console.warn(`Could not determine filename for HTML: ${fullHtmlUrl}`);
              sendMessage(`Could not determine filename for: ${link}`);
              failCount++;
              resolve(link);
              return;
            }

            zhtmls.file(
              fixFilename(
                filename.endsWith(".html") ? filename : `${filename}.html`,
              ),
              html,
            );
            successCount++;
            resolve(link);
          } catch (error) {
            console.error(`Error processing HTML ${link}:`, error);
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
          console.error(`Error downloading HTML ${link}:`, error);
          reject(error);
        },
      });
    });

    requestPromises.push(htmlPromise);
  }

  // Wait for all HTML files to be processed
  const results = await Promise.allSettled(requestPromises);
  
  // Restore original listeners
  if (originalListeners) {
    requestQueue.setEventListeners(originalListeners);
  }

  // Count failures from rejected promises
  results.forEach((result) => {
    if (result.status === 'rejected') {
      failCount++;
    }
  });

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
 * Streaming-aware version of addCssFiles
 */
export async function addCssFilesWithStreaming(
  csss: string[],
  zipProcessor: ChunkedZipProcessor,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
) {
  if (!csss?.length) return;

  const count = csss.length;
  let successCount = 0;
  let failCount = 0;
  let streamedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing CSS files with streaming for download: ${downloadId}`);
  }

  const { streamingDownloader, streamingFetcher } = getStreamingServices();

  for (let i = 0; i < count; i++) {
    const css = csss[i];
    if (!css) {
      failCount++;
      continue;
    }

    const fullCssUrl = new URL(css, tabUrl).href;

    try {
      sendMessage(`Processing CSS files: ${i + 1}/${count}`);

      // Check if file should be streamed
      const metadata = await streamingFetcher.getMetadata(fullCssUrl);
      const shouldStream = streamingDownloader.shouldUseStreaming(fullCssUrl, metadata.size);

      if (shouldStream && metadata.size > 0) {
        // Use streaming download
        sendMessage(`Starting streaming download for large CSS: ${i + 1}/${count}`);
        const download = await streamingDownloader.startDownload(fullCssUrl, {
          chunkSize: 512 * 1024, // 512KB chunks for CSS
          maxParallelChunks: 2,
          enableResumption: true,
        });

        // Wait for completion
        while (download.status !== 'completed' && download.status !== 'failed') {
          await new Promise(resolve => setTimeout(resolve, 100));
          const progress = streamingDownloader.getProgress(download.id);
          if (progress) {
            sendMessage(`CSS streaming progress: ${progress.completedChunks}/${progress.totalChunks} chunks`);
          }
        }

        if (download.status === 'completed') {
          // Add to ZIP processor
          const filename = new URL(fullCssUrl).pathname.split("/").pop() || `style-${i}.css`;
          await zipProcessor.addStreamingDownload(download, `styles/${fixFilename(filename)}`);
          successCount++;
          streamedCount++;
        } else {
          throw new Error(download.error || 'Streaming download failed');
        }
      } else {
        // Use regular download for small files
        await addSingleCssFile(fullCssUrl, zipProcessor, tabUrl);
        successCount++;
      }
    } catch (error) {
      console.error(`Error processing CSS ${fullCssUrl}:`, error);
      sendMessage(`Error processing CSS: ${fullCssUrl}`);
      failCount++;
    }
  }

  console.log(
    `CSS processing summary: ${successCount} succeeded, ${streamedCount} streamed, ${failCount} failed`,
  );
  if (failCount > 0) {
    sendMessage(
      `CSS files processed: ${successCount} succeeded, ${streamedCount} streamed, ${failCount} failed`,
    );
  }
}

/**
 * Streaming-aware version of addJsFiles
 */
export async function addJsFilesWithStreaming(
  jss: string[],
  zipProcessor: ChunkedZipProcessor,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
) {
  if (!jss?.length) return;

  const count = jss.length;
  let successCount = 0;
  let failCount = 0;
  let streamedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing JS files with streaming for download: ${downloadId}`);
  }

  const { streamingDownloader, streamingFetcher } = getStreamingServices();

  for (let i = 0; i < count; i++) {
    const js = jss[i];
    if (!js) {
      failCount++;
      continue;
    }

    const fullJsUrl = new URL(js, tabUrl).href;

    try {
      sendMessage(`Processing JS files: ${i + 1}/${count}`);

      // Check if file should be streamed
      const metadata = await streamingFetcher.getMetadata(fullJsUrl);
      const shouldStream = streamingDownloader.shouldUseStreaming(fullJsUrl, metadata.size);

      if (shouldStream && metadata.size > 0) {
        // Use streaming download
        sendMessage(`Starting streaming download for large JS: ${i + 1}/${count}`);
        const download = await streamingDownloader.startDownload(fullJsUrl, {
          chunkSize: 512 * 1024, // 512KB chunks for JS
          maxParallelChunks: 2,
          enableResumption: true,
        });

        // Wait for completion
        while (download.status !== 'completed' && download.status !== 'failed') {
          await new Promise(resolve => setTimeout(resolve, 100));
          const progress = streamingDownloader.getProgress(download.id);
          if (progress) {
            sendMessage(`JS streaming progress: ${progress.completedChunks}/${progress.totalChunks} chunks`);
          }
        }

        if (download.status === 'completed') {
          // Add to ZIP processor
          const filename = new URL(fullJsUrl).pathname.split("/").pop() || `script-${i}.js`;
          await zipProcessor.addStreamingDownload(download, `scripts/${fixFilename(filename)}`);
          successCount++;
          streamedCount++;
        } else {
          throw new Error(download.error || 'Streaming download failed');
        }
      } else {
        // Use regular download for small files
        await addSingleJsFile(fullJsUrl, zipProcessor, tabUrl);
        successCount++;
      }
    } catch (error) {
      console.error(`Error processing JS ${fullJsUrl}:`, error);
      sendMessage(`Error processing JS: ${fullJsUrl}`);
      failCount++;
    }
  }

  console.log(
    `JS processing summary: ${successCount} succeeded, ${streamedCount} streamed, ${failCount} failed`,
  );
  if (failCount > 0) {
    sendMessage(
      `JS files processed: ${successCount} succeeded, ${streamedCount} streamed, ${failCount} failed`,
    );
  }
}

/**
 * Streaming-aware version of addImageFiles
 */
export async function addImageFilesWithStreaming(
  images: string[],
  zipProcessor: ChunkedZipProcessor,
  tabUrl: string,
  sendMessage: (message: string) => void,
  downloadId?: string,
) {
  if (!images?.length) return;

  const count = images.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let streamedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    console.log(`Processing image files with streaming for download: ${downloadId}`);
  }

  const { streamingDownloader, streamingFetcher } = getStreamingServices();

  for (let i = 0; i < count; i++) {
    const image = images[i];
    if (!image || image.startsWith("data:")) {
      if (image?.startsWith("data:")) {
        successCount++; // Skip data URLs but count as success
        skippedCount++;
      }
      continue;
    }

    const fullImageUrl = new URL(image, tabUrl).href;

    try {
      sendMessage(`Processing images: ${i + 1}/${count}`);

      // Check if file should be streamed
      const metadata = await streamingFetcher.getMetadata(fullImageUrl);
      const shouldStream = streamingDownloader.shouldUseStreaming(fullImageUrl, metadata.size);

      if (shouldStream && metadata.size > 0) {
        // Use streaming download
        sendMessage(`Starting streaming download for large image: ${i + 1}/${count}`);
        const download = await streamingDownloader.startDownload(fullImageUrl, {
          chunkSize: 1024 * 1024, // 1MB chunks for images
          maxParallelChunks: 3,
          enableResumption: true,
        });

        // Wait for completion
        while (download.status !== 'completed' && download.status !== 'failed') {
          await new Promise(resolve => setTimeout(resolve, 100));
          const progress = streamingDownloader.getProgress(download.id);
          if (progress) {
            sendMessage(`Image streaming progress: ${progress.completedChunks}/${progress.totalChunks} chunks`);
          }
        }

        if (download.status === 'completed') {
          // Add to ZIP processor
          const filename = new URL(fullImageUrl).pathname.split("/").pop() || `image-${i}`;
          await zipProcessor.addStreamingDownload(download, `images/${fixFilename(filename)}`);
          successCount++;
          streamedCount++;
        } else {
          throw new Error(download.error || 'Streaming download failed');
        }
      } else {
        // Use regular download for small files
        await addSingleImageFile(fullImageUrl, zipProcessor, tabUrl);
        successCount++;
      }
    } catch (error) {
      console.error(`Error processing image ${fullImageUrl}:`, error);
      sendMessage(`Error processing image: ${fullImageUrl}`);
      failCount++;
    }
  }

  console.log(
    `Image processing summary: ${successCount} succeeded, ${streamedCount} streamed, ${failCount} failed, ${skippedCount} skipped`,
  );
  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      `Images processed: ${successCount} succeeded, ${streamedCount} streamed, ${failCount} failed, ${skippedCount} skipped`,
    );
  }
}

/**
 * Helper function to add a single CSS file using regular download
 */
async function addSingleCssFile(
  css: string,
  zipProcessor: ChunkedZipProcessor,
  tabUrl: string,
): Promise<void> {
  const response = await fetchUrl(css, tabUrl, {
    headers: {
      'Accept': 'text/css,*/*;q=0.1',
      'Cache-Control': 'no-cache',
    },
    retries: 5, // Increase retries for CSS files
    timeout: 45000, // Increase timeout for CSS files
  });
  if (!response) {
    throw new Error(`Failed to fetch CSS: ${css}`);
  }

  // Check for opaque response (CORS issue)
  if (response.type === 'opaque') {
    console.warn(`CSS ${css} returned opaque response (CORS blocked), cannot read content`);
    throw new Error(`CSS blocked by CORS policy: ${css}`);
  }

  const cssContent = await response.text();
  const filename = new URL(css, tabUrl).pathname.split("/").pop() || "style.css";

  await zipProcessor.addEntry({
    path: `styles/${fixFilename(filename)}`,
    data: new Blob([cssContent], { type: "text/css" }),
    mimeType: "text/css",
    compress: true,
  });
}

/**
 * Helper function to add a single JS file using regular download
 */
async function addSingleJsFile(
  js: string,
  zipProcessor: ChunkedZipProcessor,
  tabUrl: string,
): Promise<void> {
  const response = await fetchUrl(js, tabUrl);
  if (!response) {
    throw new Error(`Failed to fetch JS: ${js}`);
  }

  const jsContent = await response.blob();
  const filename = new URL(js, tabUrl).pathname.split("/").pop() || "script.js";

  await zipProcessor.addEntry({
    path: `scripts/${fixFilename(filename)}`,
    data: jsContent,
    mimeType: "application/javascript",
    compress: true,
  });
}

/**
 * Helper function to add a single image file using regular download
 */
async function addSingleImageFile(
  image: string,
  zipProcessor: ChunkedZipProcessor,
  tabUrl: string,
): Promise<void> {
  const response = await fetchUrl(image, tabUrl);
  if (!response) {
    throw new Error(`Failed to fetch image: ${image}`);
  }

  const imageBlob = await response.blob();
  const filename = new URL(image, tabUrl).pathname.split("/").pop() || "image.jpg";

  await zipProcessor.addEntry({
    path: `images/${fixFilename(filename)}`,
    data: imageBlob,
    mimeType: imageBlob.type,
    compress: false, // Don't compress already compressed images
  });
}

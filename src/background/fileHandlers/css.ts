import JSZip from "jszip";
import { fixFilename } from "../urlUtils";
import { DEFAULT_MEMORY_LIMITS } from "../../utils/memoryLimits";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

export async function addCssFiles(
  csss: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
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
      sendMessage({ key: "status.cssProgress", options: { completed: completedCount, total: count } });
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
      { key: "status.cssSummary", options: { succeeded: successCount, failed: failCount, skipped: skippedCount } },
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
  sendMessage: (message: string | { key: string; options?: any }) => void,
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
      sendMessage({ key: "status.bgImagesProgress", options: { completed: completedCount, total: count } });
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
      { key: "status.bgImagesSummary", options: { succeeded: successCount, failed: failCount, skipped: skippedCount } },
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

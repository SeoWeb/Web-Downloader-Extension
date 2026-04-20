import { IStorageAdapter } from "../storage/storage-adapter";
import { fixFilename } from "../urlUtils";
import { DEFAULT_MEMORY_LIMITS } from "../../utils/memoryLimits";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

export async function addCssFiles(
  csss: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  downloadId?: string,
) {
  if (!csss?.length) return;

  // Using storage adapter directly
  const count = csss.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let completedCount = 0;



  // Enqueue all CSS files
  const requestPromises: Promise<string>[] = [];
  
  for (let i = 0; i < count; i++) {
    const css = csss[i];
    
    if (!css) {
      failCount++;
      continue;
    }

    // Resolve URL like Single File mode does - use origin for relative paths
    // This fixes issues where paths like 'catalog/view/...' get wrongly appended to page path
    const tabOrigin = new URL(tabUrl).origin + '/';
    let fullCssUrl: string;
    if (css.startsWith('http')) {
      fullCssUrl = css;
    } else if (css.startsWith('//')) {
      fullCssUrl = 'https:' + css;
    } else {
      // All relative paths (both '/path' and 'path') use origin as base
      fullCssUrl = new URL(css, tabOrigin).href;
    }
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
          completedCount++;
          sendMessage({ key: "status.cssProgress", options: { completed: completedCount, total: count } });
          try {
            // Check for opaque response (CORS issue)
            if (result.response.type === 'opaque') {
              skippedCount++;
              resolve(css);
              return;
            }

            // Get CSS content
            const cssContent = await result.response.text();

            // Check CSS content size against limits
            if (cssContent.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
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
                storage,
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
              failCount++;
              resolve(css);
              return;
            }

            await storage.addFile(`styles/${fixFilename(filename)}`, blob, "text/css");
            successCount++;
            resolve(css);
          } catch (error) {
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
          failCount++;
          reject(error);
        },
      });
    });

    requestPromises.push(cssPromise);
  }

  // Wait for all CSS files to be processed
  await Promise.allSettled(requestPromises);
  
  // Failures handled inside the promise block

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
  storage: IStorageAdapter,
  baseUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  downloadId?: string,
): Promise<void> {
  // Using storage adapter directly
  const count = imageUrls.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let completedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    // Log download tracking
  }



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
          completedCount++;
          sendMessage({ key: "status.bgImagesProgress", options: { completed: completedCount, total: count } });
          try {
            const blob = await result.response.blob();
            const filename = new URL(fullImageUrl).pathname.split("/").pop();
            if (!filename) {
              sendMessage(`Could not determine filename for: ${imageUrl}`);
              failCount++;
              resolve(imageUrl);
              return;
            }

            await storage.addFile(`images/${fixFilename(filename)}`, blob);
            successCount++;
            resolve(imageUrl);
          } catch (error) {
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
          failCount++;
          reject(error);
        },
      });
    });

    requestPromises.push(imagePromise);
  }

  // Wait for all background image files to be processed
  await Promise.allSettled(requestPromises);
  
  // Failures handled inside the promise block

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
      let resolvedUrl = imageUrl;

      // Handle protocol-relative URLs (//cdn.example.com/img.jpg)
      if (imageUrl.startsWith("//")) {
        resolvedUrl = "https:" + imageUrl;
      }

      // Handle absolute-path URLs (/images/photo.jpg) - resolve against baseUrl
      if (imageUrl.startsWith("/") && !imageUrl.startsWith("//")) {
        try {
          const base = new URL(baseUrl);
          resolvedUrl = base.origin + imageUrl;
        } catch {
          // If baseUrl is invalid, just use the path as-is
        }
      }

      // Handle full http/https URLs
      if (resolvedUrl.startsWith("http")) {
        const filename = new URL(resolvedUrl).pathname.split("/").pop();
        if (filename) {
          const relativeImagePath = path + "images/" + fixFilename(filename);
          return match.replace(imageUrl, relativeImagePath);
        }
      }

      // Handle relative URLs (../images/photo.jpg, images/photo.jpg, etc.)
      if (!imageUrl.startsWith("http") && !imageUrl.startsWith("//")) {
        const filename = imageUrl.split("/").pop();
        if (filename) {
          const relativeImagePath = path + "images/" + fixFilename(filename);
          return match.replace(imageUrl, relativeImagePath);
        }
      }
    } catch {
      // Ignore
    }

    return match; // Return original if conversion fails
  });

  return updatedContent;
}

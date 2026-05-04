import { IStorageAdapter } from "../storage/storage-adapter";
import { generateImageFilename } from "../urlUtils";
import { sniffImageMimeType } from "../sniffImageMime";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

/**
 * Download image files and return a mapping from original URL to local filename.
 * This map is used by the HTML converter to rewrite image URLs correctly.
 */
export async function addImageFiles(
  images: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  downloadId?: string,
): Promise<Map<string, string>> {
  const filenameMap = new Map<string, string>();

  if (!images?.length) return filenameMap;

  // Using storage adapter directly
  const count = images.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let completedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    // TODO: Log download tracking
  }

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

    // Resolve URL like Single File mode does - use origin for relative paths
    // This fixes issues where paths like 'catalog/view/...' get wrongly appended to page path
    const tabOrigin = new URL(tabUrl).origin + "/";
    let fullImageUrl: string;
    if (image.startsWith("http")) {
      fullImageUrl = image;
    } else if (image.startsWith("//")) {
      fullImageUrl = "https:" + image;
    } else {
      // All relative paths (both '/path' and 'path') use origin as base
      fullImageUrl = new URL(image, tabOrigin).href;
    }

    // Store the original src for the filename map
    const originalSrc = image;

    // Create a promise that resolves when the image is processed
    const imagePromise = new Promise<string>(async (resolve, reject) => {
      await requestQueue.enqueue({
        url: fullImageUrl,
        resourceType: ResourceType.IMAGE,
        priority: RequestPriority.LOW, // Images are low priority
        domain: "", // Will be auto-extracted
        dependencies: [], // No dependencies for images
        retryCount: 0,
        estimatedSize: 0, // Unknown size
        fetchOptions: {
          headers: {
            Accept: "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
        },
        onComplete: async (result) => {
          completedCount++;
          sendMessage({
            key: "status.imagesProgress",
            options: { completed: completedCount, total: count },
          });
          try {
            const blob = await result.response.blob();

            // Get Content-Type to determine proper extension for extension-less URLs
            let contentType = result.response.headers.get("Content-Type") || "";

            // When Content-Type is missing or unhelpful, sniff the blob bytes
            if (
              contentType === "" ||
              contentType === "application/octet-stream"
            ) {
              const sniffed = await sniffImageMimeType(blob);
              if (sniffed) contentType = sniffed;
            }

            const filename = generateImageFilename(fullImageUrl, contentType);
            if (!filename) {
              failCount++;
              resolve(image);
              return;
            }

            await storage.addFile(
              `images/${filename}`,
              blob,
              contentType || undefined,
              originalSrc,
            );
            // Store both the original src and the full URL mapping to local filename
            filenameMap.set(originalSrc, `images/${filename}`);
            filenameMap.set(fullImageUrl, `images/${filename}`);
            successCount++;
            resolve(image);
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

  // Wait for all image files to be processed
  await Promise.allSettled(requestPromises);

  // Failures handled inside the promise block

  if (failCount > 0 || skippedCount > 0) {
    sendMessage({
      key: "status.imagesSummary",
      options: {
        succeeded: successCount,
        failed: failCount,
        skipped: skippedCount,
      },
    });
  }

  return filenameMap;
}

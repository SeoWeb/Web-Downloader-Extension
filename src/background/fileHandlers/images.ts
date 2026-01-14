import { IStorageAdapter } from "../storage/storage-adapter";
import { fixFilename } from "../urlUtils";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

export async function addImageFiles(
  images: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  downloadId?: string,
) {
  if (!images?.length) return;

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

  // Set up queue event listeners for this batch
  const originalListeners = requestQueue.getEventListeners() || {};
  
  const batchListeners = {
    ...originalListeners,
    onComplete: (result: any) => {
      completedCount++;
      sendMessage({ key: "status.imagesProgress", options: { completed: completedCount, total: count } });
      // Call original listener if it exists
      if (originalListeners.onComplete) {
        originalListeners.onComplete(result);
      }
    },
    onError: (request: any, error: Error) => {
      failCount++;
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

    // Resolve URL like Single File mode does - use origin for relative paths
    // This fixes issues where paths like 'catalog/view/...' get wrongly appended to page path
    const tabOrigin = new URL(tabUrl).origin + '/';
    let fullImageUrl: string;
    if (image.startsWith('http')) {
      fullImageUrl = image;
    } else if (image.startsWith('//')) {
      fullImageUrl = 'https:' + image;
    } else {
      // All relative paths (both '/path' and 'path') use origin as base
      fullImageUrl = new URL(image, tabOrigin).href;
    }
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
              failCount++;
              resolve(image);
              return;
            }

            await storage.addFile(`images/${fixFilename(filename)}`, blob);
            successCount++;
            resolve(image);
          } catch (error) {
            failCount++;
            reject(error);
          }
        },
        onError: (error) => {
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

  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      { key: "status.imagesSummary", options: { succeeded: successCount, failed: failCount, skipped: skippedCount } },
    );
  }
}

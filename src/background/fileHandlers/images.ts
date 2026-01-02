import JSZip from "jszip";
import { fixFilename } from "../urlUtils";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

export async function addImageFiles(
  images: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
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
      sendMessage({ key: "status.imagesProgress", options: { completed: completedCount, total: count } });
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
      { key: "status.imagesSummary", options: { succeeded: successCount, failed: failCount, skipped: skippedCount } },
    );
  }
}

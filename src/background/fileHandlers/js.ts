import JSZip from "jszip";
import { fixFilename } from "../urlUtils";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

export async function addJsFiles(
  jss: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
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
      sendMessage({ key: "status.jsProgress", options: { completed: completedCount, total: count } });
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
      { key: "status.jsSummary", options: { succeeded: successCount, failed: failCount, skipped: skippedCount } },
    );
  }
}

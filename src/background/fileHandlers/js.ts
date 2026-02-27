import { IStorageAdapter } from "../storage/storage-adapter";
import { fixFilename } from "../urlUtils";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

export async function addJsFiles(
  jss: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
  downloadId?: string,
) {
  if (!jss?.length) return;

  // Using storage adapter directly
  const count = jss.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let completedCount = 0;

  // Log download tracking if downloadId is provided
  if (downloadId) {
    // TODO: Log download tracking
  }



  // Enqueue all JS files
  const requestPromises: Promise<string>[] = [];
  
  for (let i = 0; i < count; i++) {
    const js = jss[i];
    
    if (!js) {
      failCount++;
      continue;
    }

    // Resolve URL like Single File mode does - use origin for relative paths
    // This fixes issues where paths like 'catalog/view/...' get wrongly appended to page path
    const tabOrigin = new URL(tabUrl).origin + '/';
    let fullJsUrl: string;
    if (js.startsWith('http')) {
      fullJsUrl = js;
    } else if (js.startsWith('//')) {
      fullJsUrl = 'https:' + js;
    } else {
      // All relative paths (both '/path' and 'path') use origin as base
      fullJsUrl = new URL(js, tabOrigin).href;
    }
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
          completedCount++;
          sendMessage({ key: "status.jsProgress", options: { completed: completedCount, total: count } });
          try {
            const blob = await result.response.blob();
            const filename = new URL(fullJsUrl, baseUrl).pathname.split("/").pop();
            if (!filename) {
              failCount++;
              resolve(js);
              return;
            }

            await storage.addFile(`scripts/${fixFilename(filename)}`, blob, "application/javascript");
            successCount++;
            resolve(js);
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

    requestPromises.push(jsPromise);
  }

  // Wait for all JS files to be processed
  await Promise.allSettled(requestPromises);
  


  // Count failures from rejected promises is handled inside the promise catch/onError.

  if (failCount > 0 || skippedCount > 0) {
    sendMessage(
      { key: "status.jsSummary", options: { succeeded: successCount, failed: failCount, skipped: skippedCount } },
    );
  }
}

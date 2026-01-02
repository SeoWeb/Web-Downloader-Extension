import JSZip from "jszip";
import { fixFilename } from "../urlUtils";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

export async function addContentText(text: string, zip: JSZip) {
  try {
    const blob = new Blob([text], { type: "text/plain" });
    zip.file("content.txt", blob);
  } catch (error) {
    console.error("Error creating content.txt:", error);
    throw new Error("Failed to create content.txt");
  }
}

export async function addDocumentFiles(
  documents: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
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
      sendMessage({ key: "status.documentsProgress", options: { completed: completedCount, total: count } });
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
      { key: "status.documentsSummary", options: { succeeded: successCount, failed: failCount, skipped: skippedCount } },
    );
  }
}

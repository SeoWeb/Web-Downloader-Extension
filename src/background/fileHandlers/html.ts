import JSZip from "jszip";
import { fixFilename } from "../urlUtils";
import { convertHtml } from "../htmlUtils";
import { DEFAULT_MEMORY_LIMITS } from "../../utils/memoryLimits";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, ResourceType } from "../../types/queue";

export async function addIndexHtml(
  inputHtml: string,
  zip: JSZip,
  tabUrl: string,
) {
  try {
    console.log("Converting HTML for index.html");
    
    // Validate input HTML
    if (!inputHtml || typeof inputHtml !== 'string') {
      throw new Error("Invalid HTML input: inputHtml is not a valid string");
    }
    
    // Try to convert HTML, with fallback to original if conversion fails
    let html: string;
    try {
      html = convertHtml(inputHtml, tabUrl);
    } catch (conversionError) {
      console.warn("HTML conversion failed, using original HTML:", conversionError);
      html = inputHtml; // Fallback to original HTML
    }
    
    // Ensure we have valid HTML content
    if (!html || html.length === 0) {
      throw new Error("HTML conversion resulted in empty content");
    }
    
    console.log(`Creating index.html with ${html.length} characters`);
    const blob = new Blob([html], { type: "text/html;charset=UTF-8" });
    zip.file("index.html", blob);
    console.log("index.html created successfully");
  } catch (error) {
    console.error("Error creating index.html:", error);
    
    // Provide more detailed error information
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : '';
    
    console.error("Detailed error information:", {
      message: errorMessage,
      stack: errorStack,
      inputHtmlLength: inputHtml?.length || 0,
      tabUrl: tabUrl || 'undefined'
    });
    
    throw new Error(`Failed to create index.html: ${errorMessage}`);
  }
}

export async function addHtmlFiles(
  links: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string | { key: string; options?: any }) => void,
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
      sendMessage({ key: "status.htmlProgress", options: { completed: completedCount, total: count } });
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
      { key: "status.htmlSummary", options: { succeeded: successCount, failed: failCount, skipped: skippedCount } },
    );
  }
}

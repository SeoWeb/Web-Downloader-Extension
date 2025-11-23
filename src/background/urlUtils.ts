import { memoryManager } from "../utils/MemoryManager";
import { RESOURCE_SIZE_LIMITS } from "../utils/memoryLimits";
import { requestQueue } from "../utils/RequestQueue";
import { ResourceType, RequestPriority } from "../types/queue";

export interface FetchOptions {
  retries?: number;
  delay?: number;
  timeout?: number;
  checkSize?: boolean;
  maxSize?: number;
  downloadId?: string;
  headers?: Record<string, string>;
}

export async function fetchUrl(
  url: string,
  baseUrl: string,
  options: FetchOptions = {},
): Promise<Response | null> {
  const {
    retries = 3,
    delay = 1000,
    timeout = 30000,
    checkSize = true,
    maxSize,
    downloadId,
  } = options;

  if (!url) return null;

  const fullUrl = new URL(url, baseUrl).href;
  const urlPath = new URL(fullUrl).pathname.toLowerCase();

  // Determine resource type for size limits
  const resourceType = getResourceType(urlPath);
  const sizeLimit =
    maxSize ||
    RESOURCE_SIZE_LIMITS[resourceType] ||
    RESOURCE_SIZE_LIMITS.DEFAULT;

  // Check memory availability before making request
  if (!memoryManager.checkMemoryAvailability(sizeLimit)) {
    console.warn(
      `Insufficient memory for ${fullUrl} (requires up to ${formatBytes(sizeLimit)})`,
    );
    return null;
  }

  for (let i = 0; i < retries; i++) {
    try {
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(fullUrl, {
        signal: controller.signal,
        // Add headers to prevent some blocking issues
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });

      clearTimeout(timeoutId);

      if (response.status >= 400) {
        console.warn(`HTTP ${response.status} for ${fullUrl}`);
        if (i === retries - 1) return null;
        await new Promise((res) => setTimeout(res, delay * (i + 1))); // Exponential backoff
        continue;
      }

      // Check if response is actually valid
      if (!response.body) {
        console.warn(`Empty response body for ${fullUrl}`);
        if (i === retries - 1) return null;
        await new Promise((res) => setTimeout(res, delay * (i + 1)));
        continue;
      }

      // Check Content-Length header if available and size checking is enabled
      if (checkSize && response.headers.has("Content-Length")) {
        const contentLength = parseInt(
          response.headers.get("Content-Length") || "0",
        );

        if (contentLength > sizeLimit) {
          console.warn(
            `Resource ${fullUrl} too large based on Content-Length: ${formatBytes(contentLength)} > ${formatBytes(sizeLimit)}`,
          );
          return null;
        }

        // Track the allocation if we can determine the size
        if (downloadId) {
          const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          memoryManager.queueResource({
            id: requestId,
            url: fullUrl,
            type: resourceType,
            size: contentLength,
            status: "downloading",
          });
        }
      }

      // For responses without Content-Length, we need to stream and check size
      if (checkSize && !response.headers.has("Content-Length")) {
        const limitedResponse = await createSizeLimitedResponse(
          response,
          sizeLimit,
          fullUrl,
        );
        if (!limitedResponse) {
          return null;
        }

        return limitedResponse;
      }

      return response;
    } catch (e) {
      console.warn(`Attempt ${i + 1} failed for ${fullUrl}:`, e);

      // Try alternative approach using different fetch modes for external resources
      if (i < retries - 1) {
        try {
          console.log(`Trying alternative fetch method for ${fullUrl}`);

          // For CSS files, try no-cors mode first
          const isCssFile = fullUrl.toLowerCase().includes('.css');
          const response = await fetch(fullUrl, {
            method: "GET",
            mode: isCssFile ? "no-cors" : "cors",
            cache: "no-cache",
            credentials: "omit",
            headers: isCssFile ? {
              'Accept': 'text/css,*/*;q=0.1',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            } : undefined,
          });

          // For no-cors responses, we need to handle them differently
          if (response.type === 'opaque') {
            console.warn(`Got opaque response for ${fullUrl}, may not be usable`);
            // For CSS files, opaque responses usually mean the fetch succeeded but we can't access the content
            // This is better than failing completely, so we'll try to use it
            return response;
          }

          // Apply size checking to fallback response as well
          if (checkSize && response.headers.has("Content-Length")) {
            const contentLength = parseInt(
              response.headers.get("Content-Length") || "0",
            );
            if (contentLength > sizeLimit) {
              console.warn(
                `Fallback resource ${fullUrl} too large: ${formatBytes(contentLength)} > ${formatBytes(sizeLimit)}`,
              );
              continue;
            }
          }

          return response;
        } catch (fallbackError) {
          console.warn(
            `Alternative fetch method also failed for ${fullUrl}:`,
            fallbackError,
          );

          // Try one more approach with different headers
          try {
            console.log(`Trying third fetch method for ${fullUrl}`);
            const thirdResponse = await fetch(fullUrl, {
              method: "GET",
              mode: "navigate",
              cache: "force-cache",
              redirect: "follow",
            });
            return thirdResponse;
          } catch (thirdError) {
            console.warn(`Third fetch method also failed for ${fullUrl}:`, thirdError);
          }
        }
      }

      if (i === retries - 1) {
        console.error(`Failed to fetch ${url} after ${retries} attempts`);
        return null;
      }
      await new Promise((res) => setTimeout(res, delay * (i + 1))); // Exponential backoff
    }
  }
  return null;
}

/**
 * Create a size-limited response that streams content and checks size limits
 */
async function createSizeLimitedResponse(
  originalResponse: Response,
  maxSize: number,
  url: string,
): Promise<Response | null> {
  const reader = originalResponse.body!.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      totalSize += value.length;

      if (totalSize > maxSize) {
        console.warn(
          `Resource ${url} exceeded size limit during streaming: ${formatBytes(totalSize)} > ${formatBytes(maxSize)}`,
        );
        reader.cancel();
        return null;
      }

      chunks.push(value);
    }

    // Create a new response from the collected chunks
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Create a new response with the same headers but new body
    const newResponse = new Response(combined, {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers: originalResponse.headers,
    });

    // Add a custom header to indicate size was checked
    newResponse.headers.set("X-Size-Checked", "true");
    newResponse.headers.set("X-Actual-Size", totalSize.toString());

    return newResponse;
  } catch (error) {
    console.error(`Error while checking size for ${url}:`, error);
    reader.cancel();
    return null;
  }
}

/**
 * Determine resource type from URL path for appropriate size limits
 */
function getResourceType(path: string): keyof typeof RESOURCE_SIZE_LIMITS {
  const extension = path.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
    case "bmp":
    case "ico":
      return "IMAGE";

    case "mp4":
    case "webm":
    case "avi":
    case "mov":
    case "mkv":
      return "VIDEO";

    case "mp3":
    case "wav":
    case "ogg":
    case "flac":
    case "aac":
      return "AUDIO";

    case "css":
      return "CSS";

    case "js":
    case "mjs":
    case "jsx":
    case "ts":
    case "tsx":
      return "JS";

    case "html":
    case "htm":
    case "xhtml":
      return "HTML";

    case "pdf":
      return "PDF";

    case "doc":
    case "docx":
    case "odt":
      return "DOC";

    case "zip":
    case "rar":
    case "7z":
    case "gz":
    case "tar":
      return "ZIP";

    default:
      return "DEFAULT";
  }
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}

export function fixFilename(filename: string) {
  if (!filename || typeof filename !== "string") {
    return "unknown_file";
  }

  // Remove query parameters and fragments
  const newFilename = filename.split(/[?#]/)[0];

  // Extract extension
  const extension = newFilename.split(".").pop();

  // Get the name without extension
  const nameParts = newFilename.split(".");
  const name = nameParts.slice(0, -1).join(".");

  // Clean the name
  const cleanName =
    name
      .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-") // Replace invalid chars with hyphen
      .replace(/-+/g, "-") // Replace multiple hyphens with single
      .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
      .slice(0, 100) || // Limit length
    "file"; // Default name if empty

  // Ensure we have a valid extension
  const cleanExtension =
    extension && extension.length > 0 && extension.length <= 10
      ? extension.toLowerCase()
      : "bin";

  return `${cleanName}.${cleanExtension}`;
}

/**
 * Queue-aware fetch function that uses the request queue system
 * This is the preferred method for fetching resources when the queue system is available
 */
export async function fetchUrlWithQueue(
  url: string,
  baseUrl: string,
  options: {
    priority?: RequestPriority;
    resourceType?: ResourceType;
    fetchOptions?: FetchOptions;
    onComplete?: (result: any) => void;
    onError?: (error: Error) => void;
  } = {}
): Promise<Response | null> {
  const {
    priority = RequestPriority.NORMAL,
    resourceType = ResourceType.OTHER,
    fetchOptions = {},
    onComplete,
    onError
  } = options;

  if (!url) return null;

  const fullUrl = new URL(url, baseUrl).href;
  
  // Determine resource type if not provided
  const detectedResourceType = resourceType !== ResourceType.OTHER
    ? resourceType
    : getResourceTypeFromUrl(url);

  try {
    // Create a promise that will resolve when the request completes
    return new Promise<Response | null>((resolve, reject) => {
      let isResolved = false;
      
      // Create cleanup function to prevent memory leaks
      const cleanup = () => {
        if (isResolved) return;
        isResolved = true;
      };
      
      // Enqueue the request in the queue system
      requestQueue.enqueue({
        url: fullUrl,
        resourceType: detectedResourceType,
        priority,
        domain: '', // Will be auto-extracted
        dependencies: [], // No dependencies by default
        retryCount: 0,
        estimatedSize: 0, // Unknown size
        fetchOptions: {
          ...fetchOptions,
          // Add default headers if not provided
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.5",
            ...fetchOptions.headers
          }
        },
        onComplete: async (result) => {
          try {
            // Prevent multiple resolutions
            if (isResolved) return;
            
            // Call the provided callback if any
            if (onComplete) {
              onComplete(result);
            }
            
            // Resolve the promise with the response
            resolve(result.response);
            cleanup();
          } catch (error) {
            console.error(`Error in onComplete callback for ${fullUrl}:`, error);
            if (!isResolved) {
              reject(error instanceof Error ? error : new Error(String(error)));
              cleanup();
            }
          }
        },
        onError: (error) => {
          try {
            // Prevent multiple resolutions
            if (isResolved) return;
            
            // Call the provided error callback if any
            if (onError) {
              onError(error);
            }
            
            // Reject the promise with the error
            reject(error);
            cleanup();
          } catch (callbackError) {
            console.error(`Error in onError callback for ${fullUrl}:`, callbackError);
            if (!isResolved) {
              reject(callbackError instanceof Error ? callbackError : new Error(String(callbackError)));
              cleanup();
            }
          }
        }
      }).catch((error) => {
        // Handle enqueue failure
        if (!isResolved) {
          console.error(`Failed to enqueue request for ${fullUrl}:`, error);
          if (onError) {
            onError(error instanceof Error ? error : new Error(String(error)));
          }
          resolve(null);
          cleanup();
        }
      });
    });
  } catch (error) {
    console.error(`Unexpected error in fetchUrlWithQueue for ${fullUrl}:`, error);
    if (onError) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
    return null;
  }
}

/**
 * Determine resource type from URL for queue system
 */
function getResourceTypeFromUrl(url: string): ResourceType {
  const path = new URL(url).pathname.toLowerCase();
  const extension = path.split(".").pop();

  switch (extension) {
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
    case "bmp":
    case "ico":
      return ResourceType.IMAGE;

    case "css":
      return ResourceType.CSS;

    case "js":
    case "mjs":
      return ResourceType.JS;

    case "html":
    case "htm":
    case "xhtml":
      return ResourceType.HTML;

    case "pdf":
    case "doc":
    case "docx":
    case "odt":
      return ResourceType.DOCUMENT;

    case "mp4":
    case "webm":
    case "avi":
    case "mov":
    case "mkv":
      return ResourceType.VIDEO;

    case "mp3":
    case "wav":
    case "ogg":
    case "flac":
    case "aac":
      return ResourceType.AUDIO;

    case "woff":
    case "woff2":
    case "ttf":
    case "otf":
    case "eot":
      return ResourceType.FONT;

    default:
      return ResourceType.OTHER;
  }
}

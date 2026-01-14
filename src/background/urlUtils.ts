import { memoryManager } from "../utils/MemoryManager";
import { RESOURCE_SIZE_LIMITS } from "../utils/memoryLimits";

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
    return null;
  }

  for (let i = 0; i < retries; i++) {
    try {
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // Extract origin for Referer header
      const urlOrigin = new URL(fullUrl).origin + '/';

      const response = await fetch(fullUrl, {
        signal: controller.signal,
        // Add headers to prevent some blocking issues
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Referer": urlOrigin,
          "Origin": urlOrigin.replace(/\/$/, ''),
        },
      });

      clearTimeout(timeoutId);

      if (response.status >= 400) {
        // Don't retry permanent 4xx errors (except 408 timeout and 429 rate limit)
        const isPermanentError = response.status >= 400 && response.status < 500 && 
                                 response.status !== 408 && response.status !== 429;
        if (isPermanentError) {
          return null; // Don't waste time retrying
        }
        
        if (i === retries - 1) return null;
        await new Promise((res) => setTimeout(res, delay * (i + 1))); // Exponential backoff
        continue;
      }

      // Check if response is actually valid
      if (!response.body) {
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
      // Try alternative approach using different fetch modes for external resources
      if (i < retries - 1) {
        try {
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
              continue;
            }
          }

          return response;
        } catch (fallbackError) {
          // Try one more approach with different headers
          try {
            const thirdResponse = await fetch(fullUrl, {
              method: "GET",
              mode: "navigate",
              cache: "force-cache",
              redirect: "follow",
            });
            return thirdResponse;
          } catch {
            // Ignore
          }
        }
      }

      if (i === retries - 1) {
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

  if (url) {
    // DOTO: why this url is needed?
  }

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      totalSize += value.length;

      if (totalSize > maxSize) {
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

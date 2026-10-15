import { memoryManager } from "../utils/MemoryManager";
import { RESOURCE_SIZE_LIMITS } from "../utils/memoryLimits";
import { RequestQueueError } from "../types/queue";
import type { RequestErrorCategory } from "../types/queue";

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
      const urlOrigin = new URL(fullUrl).origin + "/";

      const response = await fetch(fullUrl, {
        signal: controller.signal,
        // Add headers to prevent some blocking issues
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          Referer: urlOrigin,
          Origin: urlOrigin.replace(/\/$/, ""),
        },
      });

      clearTimeout(timeoutId);

      if (response.status >= 400) {
        // Don't retry permanent 4xx errors (except 408 timeout and 429 rate limit)
        const isPermanentError =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429;
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
          const isCssFile = fullUrl.toLowerCase().includes(".css");
          const response = await fetch(fullUrl, {
            method: "GET",
            mode: isCssFile ? "no-cors" : "cors",
            cache: "no-cache",
            credentials: "omit",
            headers: isCssFile
              ? {
                  Accept: "text/css,*/*;q=0.1",
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                }
              : undefined,
          });

          // For no-cors responses, we need to handle them differently
          if (response.type === "opaque") {
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

  // Extract query hash BEFORE stripping query params, so URLs that differ
  // only by query string (e.g. /w/load.php?modules=X vs ?modules=Y)
  // get unique filenames instead of colliding.
  const queryHash = getQueryHash(filename);

  // Remove query parameters and fragments
  const newFilename = filename.split(/[?#]/)[0];

  // Check if the filename has a recognizable file extension
  const lastDotIndex = newFilename.lastIndexOf(".");
  const hasValidExtension =
    lastDotIndex > 0 &&
    newFilename.length - lastDotIndex - 1 <= 10 &&
    newFilename.length - lastDotIndex - 1 > 0;

  if (hasValidExtension) {
    const extension = newFilename.slice(lastDotIndex + 1);
    const name = newFilename.slice(0, lastDotIndex);

    const cleanName =
      name
        .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100) || "file";

    const cleanExtension = extension.toLowerCase();
    return queryHash
      ? `${cleanName}_${queryHash}.${cleanExtension}`
      : `${cleanName}.${cleanExtension}`;
  }

  // No valid extension - sanitize the whole name and add .bin default
  // (will be corrected to proper extension by Content-Type when available)
  const cleanName =
    newFilename
      .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "file";

  return queryHash ? `${cleanName}_${queryHash}.bin` : `${cleanName}.bin`;
}

/**
 * Known image MIME types mapped to file extensions
 */
const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/vnd.microsoft.icon": "ico",
  "image/x-icon": "ico",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/tiff": "tiff",
  "image/x-tiff": "tiff",
};

/**
 * Get file extension from MIME type
 */
export function getExtensionFromMimeType(mimeType: string): string | null {
  // Strip parameters like charset
  const cleanMime = mimeType.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXTENSION[cleanMime] || null;
}

/**
 * DJB2-style short hash rendered as 8 hex chars. Shared by the query-hash
 * helpers so URLs that differ only by query string get unique filenames.
 */
function hashQueryString(query: string): string {
  if (!query || query.length <= 1) return "";
  let hash = 5381;
  for (let i = 0; i < query.length; i++) {
    hash = ((hash << 5) + hash + query.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Extract a short deterministic hash from the query string of a URL.
 * Returns an empty string if there is no query string.
 * Used to disambiguate URLs that share the same path but differ by
 * query parameters (e.g. MediaWiki load.php?modules=...).
 */
function getQueryHash(urlSrc: string): string {
  try {
    const url = new URL(urlSrc.startsWith("//") ? "https:" + urlSrc : urlSrc);
    return hashQueryString(url.search);
  } catch {
    return "";
  }
}

/**
 * Generate a consistent image filename from a URL for use by both
 * the HTML converter (convertImagesToRelative) and the image downloader (addImageFiles).
 * Handles URLs without file extensions by using a sanitized URL path as the name.
 *
 * @param urlSrc - The image URL or path (can be absolute, relative, or just a pathname)
 * @param contentType - Optional MIME type to determine proper extension for extension-less URLs
 * @returns A filename suitable for use in the images/ directory
 */
export function generateImageFilename(
  urlSrc: string,
  contentType?: string,
): string {
  if (!urlSrc || typeof urlSrc !== "string") {
    return "image.bin";
  }

  // Remove query parameters and fragments
  const cleanUrl = urlSrc.split(/[?#]/)[0];

  // Try to extract pathname from URL
  let pathname: string;
  try {
    if (
      cleanUrl.startsWith("http://") ||
      cleanUrl.startsWith("https://") ||
      cleanUrl.startsWith("//")
    ) {
      pathname = new URL(
        cleanUrl.startsWith("//") ? "https:" + cleanUrl : cleanUrl,
      ).pathname;
    } else {
      pathname = cleanUrl;
    }
  } catch {
    pathname = cleanUrl;
  }

  // Get the last path segment
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const lastSegment =
    segments.length > 0 ? segments[segments.length - 1] : "image";

  // Check if the last segment has a valid image extension
  const imageExtensions = [
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "svg",
    "bmp",
    "ico",
    "avif",
    "heic",
    "tiff",
    "tif",
  ];
  const dotIndex = lastSegment.lastIndexOf(".");
  const hasImageExtension =
    dotIndex > 0 &&
    imageExtensions.includes(lastSegment.slice(dotIndex + 1).toLowerCase());

  if (hasImageExtension) {
    if (segments.length > 1) {
      // Include parent path segments to avoid collisions when different URLs
      // share the same filename (e.g. eBay CDN: /g/ABC/s-l960.webp vs /g/XYZ/s-l960.webp)
      const fullPath = segments.join("_");
      return fixFilename(fullPath);
    }
    return fixFilename(lastSegment);
  }

  // No image extension - generate a unique deterministic name from the full path
  // Use the entire path (not just the last segment) to avoid collisions
  // e.g., /bbcswebdav/pid-4837352-dt-content-rid-31821076_1/xid-31821076_1
  // becomes: bbcswebdav_pid-4837352-dt-content-rid-31821076_1_xid-31821076_1
  //
  // For URLs with query parameters (e.g. /w/load.php?modules=site.styles),
  // include a short hash of the query string so that different resources
  // served through the same endpoint get unique filenames.
  const fullPath = segments.join("_");

  // Extract a short hash from the query string for uniqueness
  const queryHash = getQueryHash(urlSrc);

  const sanitized =
    fullPath
      .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "image";

  // Determine extension from Content-Type if available, otherwise .bin
  let extension = "bin";
  if (contentType) {
    const ext = getExtensionFromMimeType(contentType);
    if (ext) {
      extension = ext;
    }
  }

  // Append query hash if present to disambiguate same-path, different-query URLs
  return queryHash
    ? `${sanitized}_${queryHash}.${extension}`
    : `${sanitized}.${extension}`;
}

// ---------------------------------------------------------------------------
// Archive path builder (design D5 / OpenSpec task 3.1)
// ---------------------------------------------------------------------------

/** Default extension applied when the URL filename has none. */
const CATEGORY_DEFAULT_EXTENSIONS: Record<string, string> = {
  styles: "css",
  scripts: "js",
  documents: "bin",
  images: "bin",
};

/** Options for {@link buildArchivePath}. */
export interface BuildArchivePathOptions {
  /**
   * Extension used when the URL filename carries none. Overrides the
   * category default (useful when a Content-Type sniff is available).
   */
  defaultExtension?: string;
}

/** Sanitize a single archive path segment (directory or file base name). */
function sanitizeArchiveSegment(segment: string): string {
  return segment
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~\s]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/** Percent-decode a path segment, keeping the raw value on invalid input. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Build the archive path for an uploaded asset (design D5).
 *
 * Unlike the previous basename-only naming, this preserves the URL's
 * directory structure under the category prefix and hashes the query
 * string into the filename, so `/a/main.css` and `/b/main.css` (or
 * `x.css?v=1` and `x.css?v=2`) never collide. The asset registry, the
 * filename map, and the uploaded path all use this same builder so their
 * keys always match.
 *
 * @param url - Absolute URL of the asset (relative paths are handled best-effort)
 * @param category - Archive bucket prefix, e.g. "styles" | "scripts" | "images" | "documents"
 * @returns Archive path like `styles/assets/js/main_1a2b3c4d.css`
 *
 * @example
 * buildArchivePath("https://host/a/main.css", "styles")    // "styles/a/main.css"
 * buildArchivePath("https://host/x.css?v=2", "styles")     // "styles/x_<hash8>.css"
 * buildArchivePath("https://host/dir/page/img/x.png", "images") // "images/dir/page/img/x.png"
 */
export function buildArchivePath(
  url: string,
  category: string,
  options?: BuildArchivePathOptions,
): string {
  const safeCategory =
    sanitizeArchiveSegment(String(category ?? "")) || "assets";

  let pathname = "";
  let search = "";
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    search = parsed.search;
  } catch {
    // Best-effort: treat the input as a raw path with an optional query.
    const withoutHash = String(url ?? "").split("#")[0];
    const queryIndex = withoutHash.indexOf("?");
    if (queryIndex >= 0) {
      search = withoutHash.slice(queryIndex);
      pathname = withoutHash.slice(0, queryIndex);
    } else {
      pathname = withoutHash;
    }
  }

  const rawSegments = pathname
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..");

  // Strip "undefined" prefixes left behind by broken JS-generated URLs
  // (legacy handler behavior — applied here so handlers and the registry
  // that both call this builder stay consistent).
  const lastRaw = rawSegments[rawSegments.length - 1];
  if (
    lastRaw &&
    lastRaw.startsWith("undefined") &&
    lastRaw.length > "undefined".length
  ) {
    rawSegments[rawSegments.length - 1] = lastRaw.slice("undefined".length);
  }

  // A trailing slash means a directory-style URL ("/blog/"): the last
  // segment stays a directory and the filename becomes "index".
  const rawBasename = pathname.endsWith("/")
    ? "index"
    : rawSegments.pop() || "index";

  // Preserve the directory structure with sanitized segment names.
  const directorySegments = rawSegments
    .map(decodeSegment)
    .map(sanitizeArchiveSegment)
    .filter((s) => s.length > 0);

  const queryHash = search.length > 1 ? hashQueryString(search) : "";

  const dotIndex = rawBasename.lastIndexOf(".");
  const extensionLength = rawBasename.length - dotIndex - 1;
  const hasValidExtension =
    dotIndex > 0 && extensionLength > 0 && extensionLength <= 10;

  let filename: string;
  if (hasValidExtension) {
    const extension = rawBasename.slice(dotIndex + 1).toLowerCase();
    const name =
      sanitizeArchiveSegment(decodeSegment(rawBasename.slice(0, dotIndex))) ||
      "file";
    filename = queryHash
      ? `${name}_${queryHash}.${extension}`
      : `${name}.${extension}`;
  } else {
    const name = sanitizeArchiveSegment(decodeSegment(rawBasename)) || "file";
    const extension =
      options?.defaultExtension ||
      CATEGORY_DEFAULT_EXTENSIONS[safeCategory] ||
      "bin";
    filename = queryHash
      ? `${name}_${queryHash}.${extension}`
      : `${name}.${extension}`;
  }

  return [safeCategory, ...directorySegments, filename].join("/");
}

// ---------------------------------------------------------------------------
// URL scheme filtering + document-URL resolution (design D2 / tasks 3.6, 1.5)
// ---------------------------------------------------------------------------

/** Scheme prefixes that can never be fetched over HTTP(S). */
const NON_FETCHABLE_URL_PREFIXES = [
  "data:",
  "blob:",
  "chrome-extension:",
  "moz-extension:",
  "about:",
  "javascript:",
  "mailto:",
  "tel:",
] as const;

/**
 * Whether a raw resource URL can be fetched over HTTP at all.
 * Rejects empty input, fragment-only references (`#svg-fragment`, which CSS
 * `url(#gradient)` produces), and non-HTTP schemes (data:, blob:,
 * chrome-extension:, ...).
 */
export function isFetchableResourceUrl(raw: string): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  const lowered = trimmed.toLowerCase();
  return !NON_FETCHABLE_URL_PREFIXES.some((prefix) =>
    lowered.startsWith(prefix),
  );
}

/**
 * Resolve a raw resource URL against the document URL it was found in.
 *
 * Design D2: relative references must resolve against the HTML document's
 * URL, not the site origin — `img/x.png` on `https://host/dir/page.html`
 * lives at `https://host/dir/img/x.png`.
 *
 * @param raw - Raw attribute value (absolute, protocol-relative, or relative)
 * @param documentUrl - Absolute URL of the containing document, when known
 * @param fallbackBase - Legacy origin base ("https://origin/") used when no
 *   document URL is available, preserving the previous behavior
 * @returns The absolute URL, or null when the reference is not fetchable
 */
export function resolveResourceUrl(
  raw: string,
  documentUrl?: string,
  fallbackBase?: string,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!isFetchableResourceUrl(trimmed)) return null;

  if (documentUrl) {
    try {
      return new URL(trimmed, documentUrl).href;
    } catch {
      return null;
    }
  }

  // Legacy fallback: resolve against the origin (previous handler behavior).
  if (trimmed.startsWith("http")) return trimmed;
  if (trimmed.startsWith("//")) return "https:" + trimmed;
  if (!fallbackBase) return null;
  try {
    return new URL(trimmed, fallbackBase).href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Charset-aware decoding (design D6 / task 3.3)
// ---------------------------------------------------------------------------

/** Extract the charset parameter from a Content-Type header value. */
export function parseCharsetFromContentType(
  contentType?: string,
): string | null {
  if (!contentType) return null;
  const match = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return match ? match[1] : null;
}

/** Decode bytes with a charset label; null when the label is unsupported. */
function tryDecode(bytes: Uint8Array, charset: string): string | null {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decode response bytes to text honoring the declared charset:
 * 1. the `charset` parameter of the Content-Type header,
 * 2. a leading `@charset "x";` rule read from the raw bytes (CSS),
 * 3. UTF-8 as the final fallback.
 * Never reads a Response body directly — safe with queue snapshots.
 */
export function decodeTextWithCharset(
  bytes: Uint8Array | null | undefined,
  contentType?: string,
): string {
  if (!bytes || bytes.length === 0) return "";

  const headerCharset = parseCharsetFromContentType(contentType);
  if (headerCharset) {
    const decoded = tryDecode(bytes, headerCharset);
    if (decoded !== null) return decoded;
  }

  // The @charset directive is ASCII, so a Latin-1 decode of the first bytes
  // is enough to detect the label regardless of the actual encoding.
  const prefix = new TextDecoder("iso-8859-1").decode(
    bytes.subarray(0, Math.min(bytes.length, 256)),
  );
  const charsetMatch = prefix.match(/^\uFEFF?@charset\s+["']([^"']+)["']/i);
  if (charsetMatch) {
    const decoded = tryDecode(bytes, charsetMatch[1]);
    if (decoded !== null) return decoded;
  }

  return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// CSS content extraction (design D6 / tasks 3.4, url() robustness)
// ---------------------------------------------------------------------------

/**
 * Extract all `url()` references from CSS content.
 *
 * Unlike the previous lazy regex, quoted URLs may safely contain
 * parentheses: `url("foo(bar).png")` is captured whole.
 */
export function extractCssUrls(cssContent: string): string[] {
  const urls: string[] = [];
  if (!cssContent) return urls;
  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(cssContent)) !== null) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value) urls.push(value);
  }
  return urls;
}

/**
 * Extract `@import` target URLs from CSS content.
 * Handles `@import url("x")`, `@import url('x')`, `@import url(x)` and the
 * string forms `@import "x"` / `@import 'x'`, with an optional media query
 * after the target. Callers enforce recursion depth and dedup.
 */
export function extractCssImports(cssContent: string): string[] {
  const imports: string[] = [];
  if (!cssContent) return imports;
  const importPattern =
    /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)|"([^"]*)"|'([^']*)')[^;]*;/gi;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(cssContent)) !== null) {
    const value = (
      match[1] ??
      match[2] ??
      match[3] ??
      match[4] ??
      match[5] ??
      ""
    )
      .trim()
      .replace(/^url\(\s*/i, "")
      .replace(/\s*\)$/, "");
    if (value) imports.push(value);
  }
  return imports;
}

// ---------------------------------------------------------------------------
// File handler shared options + categorized failures (tasks 1.5, 2.4)
// ---------------------------------------------------------------------------

/**
 * Shared optional options threaded into the file handlers.
 * Passed as the trailing (optional) argument of each handler so existing
 * positional call sites keep working unchanged.
 */
export interface FileHandlerOptions {
  /**
   * Absolute URL of the HTML document in which the resources were found.
   * Relative resource URLs resolve against this document URL (design D2)
   * instead of the site origin. When omitted, handlers fall back to the
   * legacy origin-based resolution.
   */
  documentUrl?: string;
}

/** Failure categories reported by file handlers ("cors" extends the queue set). */
export type FileHandlerFailureCategory = RequestErrorCategory | "cors";

/** Error carrying a machine-readable failure category from a file handler. */
export class FileHandlerError extends Error {
  readonly category: FileHandlerFailureCategory;

  constructor(
    message: string,
    category: FileHandlerFailureCategory = "unknown",
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "FileHandlerError";
    this.category = category;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Map a queue/handler error to its failure category for reporting. */
export function toFailureCategory(error: unknown): FileHandlerFailureCategory {
  if (error instanceof RequestQueueError) return error.category;
  if (error instanceof FileHandlerError) return error.category;
  return "unknown";
}

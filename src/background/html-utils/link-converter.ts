import { DOMParser } from "linkedom";

/**
 * Generate a short hash suffix from a URL for filename collision avoidance.
 * Returns a 4-character alphanumeric string derived from the URL.
 */
function shortHash(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 4).padEnd(4, "0");
}

export function convertLinksToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
  pageFilenameMap?: Map<string, string>,
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const links = doc.querySelectorAll("a[href]");

  for (const link of links) {
    let href: string | null = link.getAttribute("href");
    if (!href) continue;
    
    // Remove query params for file matching
    const hrefWithoutQuery = href.split("?")[0].split("#")[0];

    const u = new URL(tabUrl);
    const baseUrl = u.origin + "/";

    // Skip anchor-only links and external links
    if (!hrefWithoutQuery) continue;
    if (href.startsWith("#")) continue;
    
    // Skip external links (different origin)
    if (href.startsWith("http://") || href.startsWith("https://")) {
      try {
        const linkUrl = new URL(href);
        if (linkUrl.origin !== u.origin) {
          continue; // External link, don't modify
        }
      } catch {
        continue;
      }
    }
    
    // Normalize the path - convert absolute and full URLs to pathname
    let normalizedPath = hrefWithoutQuery;
    if (href.startsWith(baseUrl)) {
      const url = new URL(href, baseUrl);
      normalizedPath = url.pathname;
    } else if (href.startsWith("/")) {
      normalizedPath = hrefWithoutQuery;
    }
    
    // Remove leading slash for consistent handling
    if (normalizedPath.startsWith("/")) {
      normalizedPath = normalizedPath.substring(1);
    }

    const matchDocuments = normalizedPath.match(
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|txt)$/i,
    );
    const imageMatch = normalizedPath.match(
      /\.(gif|jpe?g|tiff?|png|webp|bmp|svg|ico|heic|avif)$/i,
    );
    const htmlMatch = normalizedPath.match(/\.html$/i);
    const pathParts = normalizedPath.split("/");

    if (matchDocuments) {
      href = path + "documents/" + pathParts.pop();
    } else if (imageMatch) {
      href = path + "images/" + pathParts.pop();
    } else if (htmlMatch) {
      // HTML files go to pages/ folder.
      // Check pageFilenameMap first for collision-resolved filenames.
      const resolved = lookupPageFilename(href, tabUrl, pageFilenameMap);
      if (resolved) {
        href = path + "pages/" + resolved;
      } else {
        href = path + "pages/" + pathParts.pop();
      }
    } else {
      // Clean URLs (no extension) - treat as HTML pages
      let lastPart = pathParts.pop();
      if (!lastPart?.length) {
        lastPart = pathParts.pop();
      }
      if (!lastPart?.length) {
        continue;
      }
      // Check pageFilenameMap first for collision-resolved filenames.
      const resolved = lookupPageFilename(href, tabUrl, pageFilenameMap);
      if (resolved) {
        href = path + "pages/" + resolved;
      } else {
        href = path + "pages/" + lastPart + ".html";
      }
    }

    link.setAttribute("href", href);
  }

  return doc.documentElement.outerHTML;
}

/**
 * Look up a resolved filename from the pageFilenameMap for a given href.
 * Tries the raw href, the href without query params, and the fully resolved URL.
 * Returns the mapped filename or undefined if not found.
 */
function lookupPageFilename(
  href: string,
  tabUrl: string,
  pageFilenameMap?: Map<string, string>,
): string | undefined {
  if (!pageFilenameMap) return undefined;

  // Try raw href
  const mapped = pageFilenameMap.get(href);
  if (mapped) return mapped;

  // Try without query/fragment
  const clean = href.split("?")[0].split("#")[0];
  const mappedClean = pageFilenameMap.get(clean);
  if (mappedClean) return mappedClean;

  // Try fully resolved URL
  try {
    const fullUrl = new URL(href, tabUrl).href;
    const mappedFull = pageFilenameMap.get(fullUrl);
    if (mappedFull) return mappedFull;
    // Also try the clean version of the full URL
    const cleanFull = fullUrl.split("?")[0].split("#")[0];
    const mappedCleanFull = pageFilenameMap.get(cleanFull);
    if (mappedCleanFull) return mappedCleanFull;
  } catch {
    // Invalid URL
  }

  return undefined;
}

export { shortHash };

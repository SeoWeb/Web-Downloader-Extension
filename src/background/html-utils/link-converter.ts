import { DOMParser } from "linkedom";

export function convertLinksToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
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
      // HTML files go to pages/ folder (matching where linked-page-scraper saves them)
      href = path + "pages/" + pathParts.pop();
    } else {
      // Clean URLs (no extension) - treat as HTML pages
      let lastPart = pathParts.pop();
      if (!lastPart?.length) {
        lastPart = pathParts.pop();
      }
      if (!lastPart?.length) {
        continue;
      }
      // Add .html extension for clean URLs, save to pages/ folder
      href = path + "pages/" + lastPart + ".html";
    }

    link.setAttribute("href", href);
  }

  return doc.documentElement.outerHTML;
}

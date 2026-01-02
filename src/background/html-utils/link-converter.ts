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
    href = href.split("?")[0];

    const u = new URL(tabUrl);
    const baseUrl = u.origin + "/";

    if (!href) continue;
    else if (href.startsWith("/") || href.startsWith("#")) {
      // Already relative, skip
    } else if (href.startsWith(baseUrl)) {
      const url = new URL(href, baseUrl);
      href = url.pathname + url.search + url.hash;
    }

    const matchDocuments = href.match(
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|txt)$/i,
    );
    const imageMatch = href.match(
      /\.(gif|jpe?g|tiff?|png|webp|bmp|svg|ico|heic|avif)$/i,
    );
    const htmlMatch = href.match(/\.html$/i);
    const hrefParts = href.split("?")[0].split("#")[0].split("/");

    if (matchDocuments) {
      href = path + "documents/" + hrefParts.pop();
    } else if (imageMatch) {
      href = path + "images/" + hrefParts.pop();
    } else if (htmlMatch) {
      href = path + "html/" + hrefParts.pop();
    } else {
      let lastPart = hrefParts.pop();
      if (!lastPart?.length) {
        lastPart = hrefParts.pop();
      }
      if (!lastPart?.length) {
        continue;
      }
      href = path + "html/" + lastPart + ".html";
    }

    link.setAttribute("href", href);
  }

  return doc.documentElement.outerHTML;
}

import { DOMParser } from "linkedom";
import { fetchUrl } from "../urlUtils";

export function convertStylesToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const links = doc.querySelectorAll("link[rel='stylesheet']");

  for (const link of links) {
    let href: string | null = link.getAttribute("href");
    if (!href) continue;
    href = href.split("?")[0];

    const u = new URL(href.startsWith("http") ? href : tabUrl);
    const baseUrl = u.origin + "/";

    if (!href) continue;
    else if (href.startsWith("/") || href.startsWith("#")) {
      // Already relative, skip
    } else if (href.startsWith(baseUrl)) {
      const url = new URL(href, baseUrl);
      href = url.pathname + url.search + url.hash;
    }

    if (href.split(".").length > 1) {
      href = path + "styles/" + href.split("/").pop();
    }

    link.setAttribute("href", href);
  }

  return doc.documentElement.outerHTML;
}

export async function convertStylesToBase64(htmlString: string, tabUrl: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const links = doc.querySelectorAll("link[rel='stylesheet']");

  for (const link of links) {
    let href: string | null = link.getAttribute("href");
    if (!href) continue;

    const u = new URL(href.startsWith("http") ? href : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(href, baseUrl);
    const newLink = parser.parseFromString("<style></style>", "text/html")
      .firstChild as any;
    const content = response ? await response.text() : "";
    newLink.innerHTML = content;
    link.replaceWith(newLink);
  }

  return doc.documentElement.outerHTML;
}

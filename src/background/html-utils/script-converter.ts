import { DOMParser } from "linkedom";
import { fetchUrl } from "../urlUtils";

export function convertScriptsToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const scripts = doc.querySelectorAll("script[src]");

  for (const script of scripts) {
    let src: string | null = script.getAttribute("src");
    if (!src) continue;
    src = src.split("?")[0];

    const u = new URL(src.startsWith("http") ? src : tabUrl);
    const baseUrl = u.origin + "/";

    if (!src) continue;
    else if (src.startsWith("/") || src.startsWith("#")) {
      // Already relative, skip
    } else if (src.startsWith(baseUrl)) {
      const url = new URL(src, baseUrl);
      src = url.pathname + url.search + url.hash;
    }

    if (src.split(".").length > 1) {
      src = path + "scripts/" + src.split("/").pop();
    }

    script.setAttribute("src", src);
  }

  return doc.documentElement.outerHTML;
}

export async function convertScriptsToBase64(htmlString: string, tabUrl: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const scripts = doc.querySelectorAll("script[src]");

  for (const script of scripts) {
    let src: string | null = script.getAttribute("src");
    if (!src) continue;

    const u = new URL(src.startsWith("http") ? src : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(src, baseUrl);
    const newScript = parser.parseFromString("<script></script>", "text/html")
      .firstChild as any;
    const scriptContent = response ? await response.text() : "";
    newScript.innerHTML = scriptContent;
    script.replaceWith(newScript);
  }

  return doc.documentElement.outerHTML;
}

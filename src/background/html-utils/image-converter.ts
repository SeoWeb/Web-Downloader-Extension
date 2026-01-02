import { DOMParser } from "linkedom";
import { fetchUrl } from "../urlUtils";

export function convertImagesToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const images = doc.querySelectorAll("img[src]");

  for (const image of images) {
    let src: string | null = image.getAttribute("src");
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
      src = path + "images/" + src.split("/").pop();
    }

    image.setAttribute("src", src);
  }

  return doc.documentElement.outerHTML;
}

export async function convertImagesToBase64(htmlString: string, tabUrl: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const images = doc.querySelectorAll("img[src]");

  for (const image of images) {
    let src: string | null = image.getAttribute("src");
    if (!src) continue;
    src = src.split("?")[0];

    if (!src) continue;

    if (src.startsWith("data:")) {
      // Already base64, skip
    } else {
      const u = new URL(src.startsWith("http") ? src : tabUrl);
      const baseUrl = u.origin + "/";
      const response = await fetchUrl(src, baseUrl);
      const blob = response ? await response.blob() : null;
      if (blob) {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        src = await new Promise<string>((resolve, reject) => {
          reader.onload = () => {
            src = reader.result as string;
            resolve(src);
          };
          reader.onerror = (error) => {
            reject(error);
          };
        });
      }
    }

    image.setAttribute("src", src);
  }

  return doc.documentElement.outerHTML;
}

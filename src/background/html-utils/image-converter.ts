import { DOMParser } from "linkedom";
import { fetchUrl, generateImageFilename } from "../urlUtils";

export function convertImagesToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
  imageFilenameMap?: Map<string, string>,
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const images = doc.querySelectorAll("img[src]");

  for (const image of images) {
    let src: string | null = image.getAttribute("src");
    if (!src) continue;
    const originalSrc = src;
    src = src.split("?")[0];

    // Check the filename map first (has correct extensions from Content-Type)
    if (imageFilenameMap) {
      // Try matching with original src (before query param removal)
      const mappedFromOriginal = imageFilenameMap.get(originalSrc);
      if (mappedFromOriginal) {
        image.setAttribute("src", path + mappedFromOriginal);
        continue;
      }

      // Try matching with query-removed src
      const mappedFromClean = imageFilenameMap.get(src);
      if (mappedFromClean) {
        image.setAttribute("src", path + mappedFromClean);
        continue;
      }

      // Try resolving to full URL and matching
      try {
        const tabOrigin = new URL(tabUrl).origin + '/';
        let fullUrl: string;
        if (src.startsWith('http')) {
          fullUrl = src;
        } else if (src.startsWith('//')) {
          fullUrl = 'https:' + src;
        } else {
          fullUrl = new URL(src, tabOrigin).href;
        }
        const mappedFromFull = imageFilenameMap.get(fullUrl);
        if (mappedFromFull) {
          image.setAttribute("src", path + mappedFromFull);
          continue;
        }
      } catch {
        // URL resolution failed, fall through to default handling
      }
    }

    // Fallback: generate filename from URL (no Content-Type available)
    const u = new URL(src.startsWith("http") ? src : tabUrl);
    const baseUrl = u.origin + "/";

    if (!src) continue;
    else if (src.startsWith("/") || src.startsWith("#")) {
      // Already relative, skip
    } else if (src.startsWith(baseUrl)) {
      const url = new URL(src, baseUrl);
      src = url.pathname + url.search + url.hash;
    }

    // Always convert to local path, even for URLs without file extensions
    // (e.g., Blackboard/D2L URLs like /bbcswebdav/.../xid-31821076_1)
    const filename = generateImageFilename(src);
    src = path + "images/" + filename;

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

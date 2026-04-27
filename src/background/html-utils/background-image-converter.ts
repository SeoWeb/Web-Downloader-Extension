import { DOMParser } from "linkedom";
import { fetchUrl, fixFilename } from "../urlUtils";

export function convertBackgroundImagesToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  const elementsWithUrl = doc.querySelectorAll(
    "[style*='url(']",
  );

  for (const element of elementsWithUrl) {
    const style = element.getAttribute("style");
    if (!style) continue;

    const updatedStyle = convertBackgroundImageUrlsToRelative(
      style,
      tabUrl,
      path,
    );
    element.setAttribute("style", updatedStyle);
  }

  const styleTags = doc.querySelectorAll("style");
  for (const styleTag of styleTags) {
    const cssContent = styleTag.textContent || "";
    const updatedContent = convertBackgroundImageUrlsToRelative(
      cssContent,
      tabUrl,
      path,
    );
    styleTag.textContent = updatedContent;
  }

  return doc.documentElement.outerHTML;
}

function convertBackgroundImageUrlsToRelative(
  cssContent: string,
  tabUrl: string,
  path: string = "./",
): string {
  const bgImagePattern = /url\(['"]?(.*?)['"]?\)/gi;
  let updatedContent = cssContent;

  updatedContent = updatedContent.replace(bgImagePattern, (match, imageUrl) => {
    if (!imageUrl || imageUrl.startsWith("data:")) {
      return match;
    }

    try {
      if (!imageUrl.startsWith("http")) {
        const filename = imageUrl.split("/").pop();
        if (filename) {
          const relativeImagePath = path + "images/" + fixFilename(filename);
          return match.replace(imageUrl, relativeImagePath);
        }
      }

      const u = new URL(imageUrl.startsWith("http") ? imageUrl : tabUrl);
      const baseUrl = u.origin + "/";

      if (imageUrl.startsWith(baseUrl)) {
        const url = new URL(imageUrl, baseUrl);
        const relativePath = url.pathname;
        const filename = relativePath.split("/").pop();
        if (filename) {
          const relativeImagePath = path + "images/" + fixFilename(filename);
          return match.replace(imageUrl, relativeImagePath);
        }
      }
    } catch {
      // Ignore
    }

    return match;
  });

  return updatedContent;
}

export async function convertBackgroundImagesToBase64(
  htmlString: string,
  tabUrl: string,
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  const elementsWithUrl = doc.querySelectorAll(
    "[style*='url(']",
  );

  for (const element of elementsWithUrl) {
    const style = element.getAttribute("style");
    if (!style) continue;

    const updatedStyle = await convertBackgroundImageUrlsToBase64(
      style,
      tabUrl,
    );
    element.setAttribute("style", updatedStyle);
  }

  const styleTags = doc.querySelectorAll("style");
  for (const styleTag of styleTags) {
    const cssContent = styleTag.textContent || "";
    const updatedContent = await convertBackgroundImageUrlsToBase64(
      cssContent,
      tabUrl,
    );
    styleTag.textContent = updatedContent;
  }

  return doc.documentElement.outerHTML;
}

async function convertBackgroundImageUrlsToBase64(
  cssContent: string,
  tabUrl: string,
): Promise<string> {
  return new Promise((resolve) => {
    const bgImagePattern = /url\(['"]?(.*?)['"]?\)/gi;
    let match;

    const processImage = async (imageUrl: string) => {
      try {
        const u = new URL(imageUrl.startsWith("http") ? imageUrl : tabUrl);
        const baseUrl = u.origin + "/";
        const response = await fetchUrl(imageUrl, baseUrl);

        if (response) {
          const blob = await response.blob();
          return new Promise<string>((resolveImage) => {
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = reader.result as string;
              resolveImage(base64);
            };
            reader.onerror = () => {
              resolveImage(imageUrl);
            };
            reader.readAsDataURL(blob);
          });
        }
      } catch {
        // Ignore
      }
      return imageUrl;
    };

    const replacePromises: Promise<void>[] = [];
    const replacements: { original: string; replacement: string }[] = [];

    while ((match = bgImagePattern.exec(cssContent)) !== null) {
      const fullMatch = match[0];
      const imageUrl = match[1].trim();

      if (imageUrl && !imageUrl.startsWith("data:")) {
        replacePromises.push(
          processImage(imageUrl).then((base64Url) => {
            replacements.push({
              original: fullMatch,
              replacement: fullMatch.replace(imageUrl, base64Url),
            });
          }),
        );
      }
    }

    Promise.all(replacePromises).then(() => {
      let finalContent = cssContent;
      for (const { original, replacement } of replacements) {
        finalContent = finalContent.replace(original, replacement);
      }
      resolve(finalContent);
    });
  });
}

import { DOMParser } from "linkedom";
import { fetchUrl } from "../urlUtils";

export function convertBackgroundImagesToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  // Process inline styles with background images
  const elementsWithBgImages = doc.querySelectorAll(
    "[style*='background-image']",
  );

  for (const element of elementsWithBgImages) {
    const style = element.getAttribute("style");
    if (!style) continue;

    // Convert background-image URLs to relative paths
    const updatedStyle = convertBackgroundImageUrlsToRelative(
      style,
      tabUrl,
      path,
    );
    element.setAttribute("style", updatedStyle);
  }

  // Process style tags with background images
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
  // Regular expression to match background-image: url(...) patterns
  const bgImagePattern = /background-image\s*:\s*url\(['"]?(.*?)['"]?\)/gi;
  let updatedContent = cssContent;

  // Replace all background image URLs with relative paths
  updatedContent = updatedContent.replace(bgImagePattern, (match, imageUrl) => {
    if (!imageUrl || imageUrl.startsWith("data:")) {
      return match; // Skip data URLs
    }

    try {
      // If URL is already relative, preserve its structure but ensure it points to images folder
      if (!imageUrl.startsWith("http")) {
        const filename = imageUrl.split("/").pop();
        if (filename) {
          const relativeImagePath = path + "images/" + filename;
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
          const relativeImagePath = path + "images/" + filename;
          return match.replace(imageUrl, relativeImagePath);
        }
      }
    } catch (error) {
      console.warn(
        `Failed to convert background image URL to relative: ${imageUrl}`,
        error,
      );
    }

    return match; // Return original if conversion fails
  });

  return updatedContent;
}

// Helper function to convert background images to base64
export async function convertBackgroundImagesToBase64(
  htmlString: string,
  tabUrl: string,
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");

  // Process inline styles with background images
  const elementsWithBgImages = doc.querySelectorAll(
    "[style*='background-image']",
  );

  for (const element of elementsWithBgImages) {
    const style = element.getAttribute("style");
    if (!style) continue;

    // Convert background-image URLs to base64
    const updatedStyle = await convertBackgroundImageUrlsToBase64(
      style,
      tabUrl,
    );
    element.setAttribute("style", updatedStyle);
  }

  // Process style tags with background images
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

// Helper function to convert background image URLs to base64
async function convertBackgroundImageUrlsToBase64(
  cssContent: string,
  tabUrl: string,
): Promise<string> {
  return new Promise((resolve) => {
    // Regular expression to match background-image: url(...) patterns
    const bgImagePattern = /background-image\s*:\s*url\(['"]?(.*?)['"]?\)/gi;
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
              resolveImage(imageUrl); // Return original URL if conversion fails
            };
            reader.readAsDataURL(blob);
          });
        }
      } catch (error) {
        console.warn(
          `Failed to convert background image to base64: ${imageUrl}`,
          error,
        );
      }
      return imageUrl; // Return original URL if conversion fails
    };

    // Replace all background image URLs with base64
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
      // Apply all replacements
      let finalContent = cssContent;
      for (const { original, replacement } of replacements) {
        finalContent = finalContent.replace(original, replacement);
      }
      resolve(finalContent);
    });
  });
}

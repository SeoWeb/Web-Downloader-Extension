import { DOMParser } from "linkedom";
import { fetchUrl } from "./urlUtils";

export function convertHtml(
  inputHtml: string,
  tabUrl: string,
  path: string = "./",
) {
  let html = convertLinksToRelative(inputHtml, tabUrl, path);

  if (html.includes("<base")) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const base = doc.querySelector("base");
    if (base) {
      base.remove();
      html = doc.documentElement.outerHTML;
    }
  }

  html = convertImagesToRelative(html, tabUrl, path);
  html = convertBackgroundImagesToRelative(html, tabUrl, path);
  html = convertObjectElementsToRelative(html, tabUrl, path);
  html = convertStylesToRelative(html, tabUrl, path);
  html = convertScriptsToRelative(html, tabUrl, path);

  return html;
}

export async function convertToSingleFileHtml(
  inputHtml: string,
  tabUrl: string,
) {
  let html = inputHtml;

  if (html.includes("<base")) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const base = doc.querySelector("base");
    if (base) {
      base.remove();
      html = doc.documentElement.outerHTML;
    }
  }

  html = await convertImagesToBase64(html, tabUrl);
  html = await convertBackgroundImagesToBase64(html, tabUrl);
  html = await convertObjectElementsToBase64(html, tabUrl);
  html = await convertStylesToBase64(html, tabUrl);
  html = await convertScriptsToBase64(html, tabUrl);

  return html;
}

function convertScriptsToRelative(
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

async function convertScriptsToBase64(htmlString: string, tabUrl: string) {
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

function convertStylesToRelative(
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

async function convertStylesToBase64(htmlString: string, tabUrl: string) {
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

// Helper function to convert background images to base64
async function convertBackgroundImagesToBase64(
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
    let updatedContent = cssContent;

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

function convertImagesToRelative(
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

function convertBackgroundImagesToRelative(
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

function convertObjectElementsToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const objects = doc.querySelectorAll("object[type^='image/'][data]");

  for (const object of objects) {
    let data: string | null = object.getAttribute("data");
    if (!data) continue;
    data = data.split("?")[0];

    const u = new URL(data.startsWith("http") ? data : tabUrl);
    const baseUrl = u.origin + "/";

    if (!data) continue;
    else if (data.startsWith("/") || data.startsWith("#")) {
      // Already relative, skip
    } else if (data.startsWith(baseUrl)) {
      const url = new URL(data, baseUrl);
      data = url.pathname + url.search + url.hash;
    }

    if (data.split(".").length > 1) {
      data = path + "images/" + data.split("/").pop();
    }

    object.setAttribute("data", data);
  }

  return doc.documentElement.outerHTML;
}

async function convertObjectElementsToBase64(
  htmlString: string,
  tabUrl: string,
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const objects = doc.querySelectorAll("object[type^='image/'][data]");

  for (const object of objects) {
    let data: string | null = object.getAttribute("data");
    if (!data) continue;

    const u = new URL(data.startsWith("http") ? data : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(data, baseUrl);

    if (response) {
      const blob = await response.blob();
      const reader = new FileReader();
      reader.readAsDataURL(blob);

      data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          data = reader.result as string;
          resolve(data);
        };
        reader.onerror = (error) => {
          reject(error);
        };
      });
    }

    object.setAttribute("data", data);
  }

  return doc.documentElement.outerHTML;
}

async function convertImagesToBase64(htmlString: string, tabUrl: string) {
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
        const reder = new FileReader();
        reder.readAsDataURL(blob);
        src = await new Promise<string>((resolve, reject) => {
          reder.onload = () => {
            src = reder.result as string;
            resolve(src);
          };
          reder.onerror = (error) => {
            reject(error);
          };
        });
      }
    }

    image.setAttribute("src", src);
  }

  return doc.documentElement.outerHTML;
}

function convertLinksToRelative(
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

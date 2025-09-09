import JSZip from "jszip";
import { fetchUrl, fixFilename } from "./urlUtils";
import { convertHtml } from "./htmlUtils";

export async function addIndexHtml(inputHtml: string, zip: JSZip, tabUrl: string) {
  try {
    const html = convertHtml(inputHtml, tabUrl);
    const blob = new Blob([html], { type: "text/html" });
    zip.file("index.html", blob);
  } catch (error) {
    console.error('Error creating index.html:', error);
    throw new Error('Failed to create index.html');
  }
}

export async function addContentText(text: string, zip: JSZip) {
  try {
    const blob = new Blob([text], { type: "text/plain" });
    zip.file("content.txt", blob);
  } catch (error) {
    console.error('Error creating content.txt:', error);
    throw new Error('Failed to create content.txt');
  }
}

export async function addCssFiles(
  csss: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (!csss?.length) return;

  const zstyles = zip.folder("styles") || zip;
  const count = csss.length;
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < count; i++) {
    const css = csss[i];
    sendMessage(`Downloading CSS files: ${i+1}/${count}`);
    if (!css) {
      failCount++;
      continue;
    }

    try {
      const u = new URL(css.startsWith("http") ? css : tabUrl);
      const baseUrl = u.origin;
      const response = await fetchUrl(css, baseUrl);
      
      if (!response) {
        console.warn(`Failed to fetch CSS: ${css}`);
        sendMessage(`Failed to download CSS: ${css}`);
        failCount++;
        continue;
      }

      const cssContent = await response.text();
      
      // Extract background images from CSS content
      const backgroundImages = extractBackgroundImagesFromCSS(cssContent);
      
      // Download background images
      if (backgroundImages.length > 0) {
        await downloadBackgroundImages(backgroundImages, zip, baseUrl, sendMessage);
      }

      // Convert background image URLs to relative paths in CSS
      const updatedCssContent = convertBackgroundImageUrlsToRelative(cssContent, baseUrl, "../");

      const blob = new Blob([updatedCssContent], { type: "text/css" });
      const filename = new URL(css, baseUrl).pathname.split('/').pop();
      if (!filename) {
        console.warn(`Could not determine filename for CSS: ${css}`);
        sendMessage(`Could not determine filename for: ${css}`);
        failCount++;
        continue;
      }

      zstyles.file(fixFilename(filename), blob);
      successCount++;
    } catch (error) {
      console.error(`Error downloading CSS ${css}:`, error);
      sendMessage(`Error downloading CSS: ${css}`);
      failCount++;
    }
  }

  console.log(`CSS download summary: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    sendMessage(`CSS files downloaded: ${successCount} succeeded, ${failCount} failed`);
  }
}

// Helper function to extract background images from CSS content
function extractBackgroundImagesFromCSS(cssContent: string): string[] {
  const imageUrls: string[] = [];
  
  // Regular expression to match url() patterns in CSS
  const urlPattern = /url\(['"]?(.*?)['"]?\)/g;
  let match;
  
  while ((match = urlPattern.exec(cssContent)) !== null) {
    const imageUrl = match[1].trim();
    if (imageUrl && !imageUrl.startsWith('data:')) {
      imageUrls.push(imageUrl);
    }
  }
  
  return imageUrls;
}

// Helper function to download background images found in CSS
async function downloadBackgroundImages(
  imageUrls: string[],
  zip: JSZip,
  baseUrl: string,
  sendMessage: (message: string) => void
): Promise<void> {
  const zimages = zip.folder("images") || zip;
  const count = imageUrls.length;
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < count; i++) {
    const imageUrl = imageUrls[i];
    sendMessage(`Downloading background images from CSS: ${i+1}/${count}`);
    if (!imageUrl) {
      failCount++;
      continue;
    }

    try {
      const response = await fetchUrl(imageUrl, baseUrl);
      
      if (!response) {
        console.warn(`Failed to fetch background image: ${imageUrl}`);
        sendMessage(`Failed to download background image: ${imageUrl}`);
        failCount++;
        continue;
      }

      const blob = await response.blob();
      const filename = new URL(imageUrl, baseUrl).pathname.split('/').pop();
      if (!filename) {
        console.warn(`Could not determine filename for background image: ${imageUrl}`);
        sendMessage(`Could not determine filename for: ${imageUrl}`);
        failCount++;
        continue;
      }

      zimages.file(fixFilename(filename), blob);
      successCount++;
    } catch (error) {
      console.error(`Error downloading background image ${imageUrl}:`, error);
      sendMessage(`Error downloading background image: ${imageUrl}`);
      failCount++;
    }
  }

  console.log(`Background images from CSS download summary: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    sendMessage(`Background images from CSS downloaded: ${successCount} succeeded, ${failCount} failed`);
  }
}

// Helper function to convert background image URLs to relative paths in CSS
function convertBackgroundImageUrlsToRelative(cssContent: string, baseUrl: string, path: string = "./"): string {
  // Regular expression to match url() patterns in CSS
  const urlPattern = /url\(['"]?(.*?)['"]?\)/gi;
  let updatedContent = cssContent;
  
  // Replace all image URLs with relative paths
  updatedContent = updatedContent.replace(urlPattern, (match, imageUrl) => {
    if (!imageUrl || imageUrl.startsWith('data:')) {
      return match; // Skip data URLs
    }
    
    try {
      // If URL is already relative, preserve its structure but ensure it points to images folder
      if (!imageUrl.startsWith('http')) {
        const filename = imageUrl.split('/').pop();
        if (filename) {
          const relativeImagePath = path + "images/" + filename;
          return match.replace(imageUrl, relativeImagePath);
        }
      }
      
      if (imageUrl.startsWith(baseUrl)) {
        const url = new URL(imageUrl, baseUrl);
        const relativePath = url.pathname;
        const filename = relativePath.split('/').pop();
        if (filename) {
          const relativeImagePath = path + "images/" + filename;
          return match.replace(imageUrl, relativeImagePath);
        }
      }
    } catch (error) {
      console.warn(`Failed to convert image URL to relative: ${imageUrl}`, error);
    }
    
    return match; // Return original if conversion fails
  });
  
  return updatedContent;
}

export async function addJsFiles(
  jss: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (!jss?.length) return;

  const zscripts = zip.folder("scripts") || zip;
  const count = jss.length;
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < count; i++) {
    const js = jss[i];
    sendMessage(`Downloading JS files: ${i+1}/${count}`);
    if (!js) {
      failCount++;
      continue;
    }

    try {
      const u = new URL(js.startsWith("http") ? js : tabUrl);
      const baseUrl = u.origin;
      const response = await fetchUrl(js, baseUrl);
      
      if (!response) {
        console.warn(`Failed to fetch JS: ${js}`);
        sendMessage(`Failed to download JS: ${js}`);
        failCount++;
        continue;
      }

      const blob = await response.blob();
      const filename = new URL(js, baseUrl).pathname.split('/').pop();
      if (!filename) {
        console.warn(`Could not determine filename for JS: ${js}`);
        sendMessage(`Could not determine filename for: ${js}`);
        failCount++;
        continue;
      }

      zscripts.file(fixFilename(filename), blob);
      successCount++;
    } catch (error) {
      console.error(`Error downloading JS ${js}:`, error);
      sendMessage(`Error downloading JS: ${js}`);
      failCount++;
    }
  }

  console.log(`JS download summary: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    sendMessage(`JS files downloaded: ${successCount} succeeded, ${failCount} failed`);
  }
}

export async function addDocumentFiles(
  documents: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (!documents?.length) {
    return;
  }

  const zdocuments = zip.folder("documents") || zip;
  let successCount = 0;
  let failCount = 0;
  const count = documents.length;

  for (let i = 0; i < count; i++) {
    const document = documents[i];
    sendMessage(`Downloading document files: ${i+1}/${count}`);
    if (!document) {
      failCount++;
      continue;
    }

    try {
      const u = new URL(document.startsWith("http") ? document : tabUrl);
      const baseUrl = u.origin;
      const response = await fetchUrl(document, baseUrl);
      
      if (!response) {
        console.error(`Failed to fetch document: ${document}`);
        sendMessage(`Failed to download document: ${document}`);
        failCount++;
        continue;
      }

      const blob = await response.blob();
      const filename = new URL(document, baseUrl).pathname.split('/').pop();
      if (!filename) {
        console.error(`Could not determine filename for document: ${document}`);
        sendMessage(`Could not determine filename for: ${document}`);
        failCount++;
        continue;
      }

      zdocuments.file(fixFilename(filename), blob);
      successCount++;
    } catch (error) {
      console.error(`Error downloading document ${document}:`, error);
      sendMessage(`Error downloading document: ${document}`);
      failCount++;
    }
  }

  console.log(`Document download summary: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    sendMessage(`Document files downloaded: ${successCount} succeeded, ${failCount} failed`);
  }
}

export async function addImageFiles(
  images: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (!images?.length) return;

  const zimages = zip.folder("images") || zip;
  const count = images.length;
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < count; i++) {
    const image = images[i];
    sendMessage(`Downloading images: ${i+1}/${count}`);
    if (!image) {
      failCount++;
      continue;
    }
    
    if (image.startsWith("data:")) {
      successCount++;
      continue;
    }

    try {
      const u = new URL(image.startsWith("http") ? image : tabUrl);
      const baseUrl = u.origin;
      const response = await fetchUrl(image, baseUrl);
      
      if (!response) {
        console.warn(`Failed to fetch image: ${image}`);
        sendMessage(`Failed to download image: ${image}`);
        failCount++;
        continue;
      }

      const blob = await response.blob();
      const filename = new URL(image, baseUrl).pathname.split('/').pop();
      if (!filename) {
        console.warn(`Could not determine filename for image: ${image}`);
        sendMessage(`Could not determine filename for: ${image}`);
        failCount++;
        continue;
      }

      zimages.file(fixFilename(filename), blob);
      successCount++;
    } catch (error) {
      console.error(`Error downloading image ${image}:`, error);
      sendMessage(`Error downloading image: ${image}`);
      failCount++;
    }
  }

  console.log(`Image download summary: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    sendMessage(`Images downloaded: ${successCount} succeeded, ${failCount} failed`);
  }
}

export async function addHtmlFiles(
  links: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (!links?.length) return;

  const zhtmls = zip.folder("html") || zip;
  const count = links.length;
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < count; i++) {
    const link = links[i];
    sendMessage(`Downloading linked html files: ${i+1}/${count}`);
    if (!link) {
      failCount++;
      continue;
    }

    try {
      const u = new URL(tabUrl);
      const baseUrl = u.origin;
      const response = await fetchUrl(link, baseUrl);
      
      if (!response) {
        console.warn(`Failed to fetch HTML: ${link}`);
        sendMessage(`Failed to download HTML: ${link}`);
        failCount++;
        continue;
      }

      const inputHtml = await response.text();
      const html = convertHtml(inputHtml, tabUrl, "../");
      const filename = new URL(link, baseUrl).pathname.split('/').pop();
      if (!filename?.length) {
        console.warn(`Could not determine filename for HTML: ${link}`);
        sendMessage(`Could not determine filename for: ${link}`);
        failCount++;
        continue;
      }

      zhtmls.file(fixFilename(filename.endsWith('.html') ? filename : `${filename}.html`), html);
      successCount++;
    } catch (error) {
      console.error(`Error downloading HTML ${link}:`, error);
      sendMessage(`Error downloading HTML: ${link}`);
      failCount++;
    }
  }

  console.log(`HTML download summary: ${successCount} succeeded, ${failCount} failed`);
  if (failCount > 0) {
    sendMessage(`HTML files downloaded: ${successCount} succeeded, ${failCount} failed`);
  }
}

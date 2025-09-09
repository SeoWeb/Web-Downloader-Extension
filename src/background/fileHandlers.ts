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

      const blob = await response.blob();
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

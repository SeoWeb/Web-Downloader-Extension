import JSZip from "jszip";
import { fetchUrl, fixFilename } from "./urlUtils";
import { convertHtml } from "./htmlUtils";

export async function addIndexHtml(inputHtml: string, zip: JSZip, tabUrl: string) {
  const html = convertHtml(inputHtml, tabUrl);
  const blob = new Blob([html], { type: "text/html" });
  zip.file("index.html", blob);
}

export async function addContentText(text: string, zip: JSZip) {
  const blob = new Blob([text], { type: "text/plain" });
  zip.file("content.txt", blob);
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
  
  for (let i = 0; i < count; i++) {
    const css = csss[i];
    sendMessage(`Downloading CSS files: ${i+1}/${count}`);
    if (!css) continue;

    const u = new URL(css.startsWith("http") ? css : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(css, baseUrl);
    if (!response) continue;

    const blob = await response.blob();
    const filename = css.split("/").pop();
    if (!filename) continue;

    zstyles.file(fixFilename(filename), blob);
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
  
  for (let i = 0; i < count; i++) {
    const js = jss[i];
    sendMessage(`Downloading JS files: ${i+1}/${count}`);
    if (!js) continue;

    const u = new URL(js.startsWith("http") ? js : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(js, baseUrl);
    if (!response) continue;

    const blob = await response.blob();
    const filename = js.split("/").pop();
    if (!filename) continue;

    zscripts.file(fixFilename(filename), blob);
  }
}

export async function addDocumentFiles(
  documents: string[],
  zip: JSZip,
  tabUrl: string,
  sendMessage: (message: string) => void
) {
  if (!documents?.length) {
    console.log("No documents to download");
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
      console.log(`Skipping empty document at index ${i}`);
      failCount++;
      continue;
    }

    try {
      console.log(`Downloading document ${i + 1}/${count}: ${document}`);
      const u = new URL(document.startsWith("http") ? document : tabUrl);
      const baseUrl = u.origin + "/";
      const response = await fetchUrl(document, baseUrl);
      
      if (!response) {
        console.error(`Failed to fetch document: ${document}`);
        failCount++;
        continue;
      }

      const blob = await response.blob();
      const filename = document.split("/").pop();
      if (!filename) {
        console.error(`Could not determine filename for document: ${document}`);
        failCount++;
        continue;
      }

      zdocuments.file(fixFilename(filename), blob);
      successCount++;
      console.log(`Successfully downloaded document: ${filename}`);
    } catch (error) {
      console.error(`Error downloading document ${document}:`, error);
      failCount++;
    }
  }

  console.log(`Document download summary: ${successCount} succeeded, ${failCount} failed`);
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
  
  for (let i = 0; i < count; i++) {
    const image = images[i];
    sendMessage(`Downloading images: ${i+1}/${count}`);
    if (!image || image.startsWith("data:")) continue;

    const u = new URL(image.startsWith("http") ? image : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(image, baseUrl);
    if (!response) continue;

    const blob = await response.blob();
    const filename = image.split("/").pop();
    if (!filename) continue;

    zimages.file(fixFilename(filename), blob);
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
  
  for (let i = 0; i < count; i++) {
    const link = links[i];
    sendMessage(`Downloading linked html files: ${i+1}/${count}`);
    if (!link) continue;

    const u = new URL(tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(link, baseUrl);
    if (!response) continue;

    const inputHtml = await response.text();
    const html = convertHtml(inputHtml, tabUrl, "../");
    const parts = link.split("/");
    let filename = parts.pop();
    if (!filename?.length) filename = parts.pop();
    if (!filename?.length) continue;
    if (!filename.endsWith(".html")) filename += ".html";

    zhtmls.file(fixFilename(filename), html);
  }
}
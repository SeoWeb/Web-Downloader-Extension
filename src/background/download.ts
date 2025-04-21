import JSZip from "jszip";
import { getResources } from "./resources";
import { DOMParser } from "linkedom";
// import { messageActions } from "../common/message";

export async function downloadResources(
  html: string,
  tabUrl: string,
  downloadOptions: {
    downloadHTML: boolean;
    downloadImages: boolean;
    downloadLinks: boolean;
    downloadAssets: boolean;
    downloadContentAsText: boolean;
    downloadDocuments: boolean;
    singleFile: boolean;
  },
  sendMessage: (message: string) => void,
) {
  console.log("Starting downloadResources for URL:", tabUrl);
  
  if (!tabUrl) {
    console.error("No tab URL provided");
    return;
  }

  // Check network connectivity
  // try {
  //   const online = await new Promise(resolve => {
  //     chrome.runtime.sendMessage(
  //       {action: messageActions.CHECK_ONLINE_STATUS},
  //       resolve
  //     );
  //   });
  //   if (!online) {
  //     sendMessage("No internet connection - cannot download");
  //     console.error("No internet connection");
  //     return;
  //   }
  // } catch (error) {
  //   console.error("Network check failed:", error);
  //   sendMessage("Failed to check network status");
  //   return;
  // }

  const zip = new JSZip();
  const data = getResources(html);
  console.log("Extracted resources:", data);

  const u = new URL(tabUrl || "");
  let zipFilename = u.pathname
  .split("/")
  .slice(1)
  .join("-")
  .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "") // Replace invalid characters
  .slice(0, 200) // Limit filename length to 200 characters
  + `${Date.now()}.zip`;

  if (downloadOptions.downloadHTML) {
    console.log("Creating index.html");
    sendMessage("Creating index.html");
    await addIndexHtml(html, zip, tabUrl);
    console.log("index.html created");
    sendMessage("Index.html created");
  }

  if (downloadOptions.downloadAssets) {
    console.log("Downloading assets");
    sendMessage("Downloading CSS files");
    try {
      await addCssFiles(data.css, zip, tabUrl, sendMessage);
      console.log("CSS files downloaded:", data.css.length);
      sendMessage("CSS files downloaded");
    } catch (error) {
      console.error("Error downloading CSS files:", error);
      sendMessage("Error downloading CSS files - some may be missing");
    }

    sendMessage("Downloading JS files");
    try {
      await addJsFiles(data.js, zip, tabUrl, sendMessage);
      console.log("JS files downloaded:", data.js.length);
      sendMessage("JS files downloaded");
    } catch (error) {
      console.error("Error downloading JS files:", error);
      sendMessage("Error downloading JS files - some may be missing");
    }
  }

  if (downloadOptions.downloadDocuments) {
    console.log("Downloading documents");
    sendMessage("Downloading document files");
    await addDocumentFiles(data.documents, zip, tabUrl, sendMessage);
    console.log("Documents downloaded:", data.documents.length);
    sendMessage("Document files downloaded");
  }

  if (downloadOptions.downloadImages) {
    console.log("Downloading images");
    sendMessage("Downloading images");
    await addImageFiles(data.images, zip, tabUrl, sendMessage);
    console.log("Images downloaded:", data.images.length);
    sendMessage("Images downloaded");
  }

  if (downloadOptions.downloadLinks) {
    console.log("Downloading linked HTML files");
    sendMessage("Downloading linked html files");
    await addHtmlFiles(data.links, zip, tabUrl, sendMessage);
    console.log("Linked HTML files downloaded:", data.links.length);
    sendMessage("Linked html files downloaded");
  }

  if (downloadOptions.downloadContentAsText) {
    console.log("Downloading content as text");
    sendMessage("Downloading content as text");
    await addContentText(data.text, zip);
    console.log("Content text downloaded");
    sendMessage("Content as text downloaded");
  }

  try {
    console.log("Creating final download package");
    let blob: any;

    if (downloadOptions.singleFile) {
      sendMessage("Creating index.html");
      const singleFileHtml = await convertToSingleFileHtml(html, tabUrl);
      blob = new Blob([singleFileHtml], { type: "text/html;charset=UTF-8" });
      zipFilename = zipFilename.replace(".zip", ".html");
      console.log("Single HTML file created");
    } else {
      console.log("Generating ZIP archive");
      blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      });
      console.log("ZIP archive created");
    }

    console.log("Preparing download");
    if (!blob) {
      throw new Error("No blob data available for download");
    }

    const reader = new FileReader();
    
    reader.onloadend = async function() {
      try {
        if (!reader.result) {
          throw new Error("FileReader returned no result");
        }

        const resultString = reader.result as string;
        if (!resultString.includes(',')) {
          throw new Error("Invalid data URL format from FileReader");
        }

        const base64data = resultString.split(",")[1];
        if (!base64data) {
          throw new Error("Failed to extract base64 data from result");
        }

        const downloadWithRetry = async (attempt = 1): Promise<void> => {
          try {
            console.log(`Initiating Chrome download (attempt ${attempt}):`, zipFilename);
            const downloadId = await new Promise((resolve, reject) => {
              chrome.downloads.download({
                url: "data:application/octet-stream;base64," + base64data,
                filename: zipFilename,
                saveAs: false,
              }, (downloadId) => {
                if (chrome.runtime.lastError) {
                  reject(chrome.runtime.lastError);
                } else {
                  resolve(downloadId);
                }
              });
            });
            
            console.log("Download started successfully, ID:", downloadId);
            sendMessage("Download started successfully");
          } catch (error) {
            if (attempt >= 3) {
              throw error;
            }
            console.warn(`Download attempt ${attempt} failed, retrying...`, error);
            await new Promise(res => setTimeout(res, 1000 * attempt));
            return downloadWithRetry(attempt + 1);
          }
        };

        await downloadWithRetry();
      } catch (error) {
        console.error("Download preparation error:", error);
        sendMessage("Failed to prepare download - check your internet connection");
      }
    };

    reader.onerror = function(error) {
      console.error("FileReader error:", error);
      let errorMessage = "Failed to read download data";
      
      if (error?.target?.error) {
        const fileReaderError = error.target.error;
        errorMessage += `: ${fileReaderError.name} - ${fileReaderError.message}`;
        
        if (fileReaderError.name === 'NotReadableError') {
          errorMessage += ". The file may be corrupted or in an unsupported format.";
        }
      }
      
      sendMessage(errorMessage);
    };

    reader.readAsDataURL(blob);
  } catch (error) {
    console.error("Error creating download package:", error);
    sendMessage("Failed to create download package");
  }

  return data.links;
}

async function addIndexHtml(inputHtml: string, zip: JSZip, tabUrl: string) {
  const html = convertHtml(inputHtml, tabUrl);
  const blob = new Blob([html], { type: "text/html" });

  zip.file("index.html", blob);
}

async function addContentText(text: string, zip: JSZip) {
  const blob = new Blob([text], { type: "text/plain" });
  zip.file("content.txt", blob);
}

function convertHtml(inputHtml: string, tabUrl: string, path: string = "./") {
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
  html = convertStylesToRelative(html, tabUrl, path);
  html = convertScriptsToRelative(html, tabUrl, path);

  return html;
}

async function convertToSingleFileHtml(inputHtml: string, tabUrl: string) {
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
  html = await convertStylesToBase64(html, tabUrl);
  html = await convertScriptsToBase64(html, tabUrl);

  return html;
}

async function addCssFiles(csss: string[], zip: JSZip, tabUrl: string, sendMessage: (message: string) => void) {
  if (!csss?.length) {
    return;
  }

  const zstyles = zip.folder("styles") || zip;

  const count = csss.length;
  let i = 0;
  for (const css of csss) {
    i++;
    sendMessage(`Downloading: ${i}/${count}`);
    if (!css) {
      continue;
    }
    const u = new URL(css.startsWith("http") ? css : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(css, baseUrl);
    if (!response) {
      continue;
    }

    const blob = await response.blob();
    const filename = css.split("/").pop();

    if (!filename) {
      continue;
    }

    zstyles.file(fixFilename(filename), blob);
  }
}

function fixFilename(filename: string) {
  const newFilename = filename.split("?")[0];
  const extension = newFilename.split(".").pop();
  const name = newFilename
  .split(".")
  .slice(0, -1)
  .join(".")
  .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "") // Replace invalid characters
  .slice(0, 200); // Truncate to 200 characters

  return `${name}.${extension}`;
}

async function addJsFiles(jss: string[], zip: JSZip, tabUrl: string, sendMessage: (message: string) => void) {
  if (!jss?.length) {
    return;
  }

  const zscripts = zip.folder("scripts") || zip;

  const count = jss.length;
  let i = 0;
  for (const js of jss) {
    i++;
    sendMessage(`Downloading: ${i}/${count}`);
    if (!js) {
      continue;
    }

    const u = new URL(js.startsWith("http") ? js : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(js, baseUrl);
    if (!response) {
      continue;
    }

    const blob = await response.blob();
    const filename = js.split("/").pop();

    if (!filename) {
      continue;
    }

    zscripts.file(fixFilename(filename), blob);
  }
}

async function addDocumentFiles(
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

  const docs = documents.entries();
  const count = documents.length;
  for (const [index, document] of docs) {
    sendMessage(`Downloading: ${index+1}/${count}`);
    if (!document) {
      console.log(`Skipping empty document at index ${index}`);
      failCount++;
      continue;
    }

    try {
      console.log(`Downloading document ${index + 1}/${documents.length}: ${document}`);
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

async function addImageFiles(images: string[], zip: JSZip, tabUrl: string, sendMessage: (message: string) => void) {
  if (!images?.length) {
    return;
  }

  const zimages = zip.folder("images") || zip;

  const count = images.length;
  let i = 1;
  for (const image of images) {
    i++;
    sendMessage(`Downloading: ${i}/${count}`);
    if (!image || image.startsWith("data:")) {
      continue;
    }

    const u = new URL(image.startsWith("http") ? image : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(image, baseUrl);
    if (!response) {
      continue;
    }

    const blob = await response.blob();
    const filename = image.split("/").pop();

    if (!filename) {
      continue;
    }

    zimages.file(fixFilename(filename), blob);
  }
}

async function addHtmlFiles(links: string[], zip: JSZip, tabUrl: string, sendMessage: (message: string) => void) {
  if (!links?.length) {
    return;
  }

  const zhtmls = zip.folder("html") || zip;

  const count = links.length;
  let i = 1;
  for (const link of links) {
    i++;
    sendMessage(`Downloading: ${i}/${count}`);
    if (!link) {
      continue;
    }

    const u = new URL(tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(link, baseUrl);
    if (!response) {
      continue;
    }

    // const blob = await response.blob();
    const inputHtml = await response.text();
    const html = convertHtml(inputHtml, tabUrl, "../");

    const parts = link.split("/");
    let filename = parts.pop();

    if (!filename?.length) {
      filename = parts.pop();
    }

    if (!filename?.length) {
      continue;
    }

    if (!filename.endsWith(".html")) {
      filename += ".html";
    }

    zhtmls.file(fixFilename(filename), html);
  }
}

async function fetchUrl(url: string, baseUrl: string, retries = 3, delay = 1000) {
  if (!url) {
    return null;
  }

  const fullUrl = new URL(url, baseUrl).href;
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(fullUrl);

      if (response.status >= 400) {
        if (i === retries - 1) return null;
        await new Promise(res => setTimeout(res, delay));
        continue;
      }

      return response;
    } catch (e) {
      if (i === retries - 1) {
        console.error(`Failed to fetch ${url} after ${retries} attempts`);
        return null;
      }
      await new Promise(res => setTimeout(res, delay));
    }
  }
  return null;
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

    if (!src) {
      continue;
    }
    src = src.split("?")[0];

    const u = new URL(src.startsWith("http") ? src : tabUrl);
    const baseUrl = u.origin + "/";

    if (!src) {
      continue;
    } else if (src.startsWith("/") || src.startsWith("#")) {
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
    if (!src) {
      continue;
    }

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

    if (!href) {
      continue;
    }
    href = href.split("?")[0];

    const u = new URL(href.startsWith("http") ? href : tabUrl);
    const baseUrl = u.origin + "/";

    if (!href) {
      continue;
    } else if (href.startsWith("/") || href.startsWith("#")) {
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
    if (!href) {
      continue;
    }

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

    if (!src) {
      continue;
    }
    src = src.split("?")[0];

    const u = new URL(src.startsWith("http") ? src : tabUrl);
    const baseUrl = u.origin + "/";

    if (!src) {
      continue;
    } else if (src.startsWith("/") || src.startsWith("#")) {
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

async function convertImagesToBase64(htmlString: string, tabUrl: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const images = doc.querySelectorAll("img[src]");

  for (const image of images) {
    let src: string | null = image.getAttribute("src");

    if (!src) {
      continue;
    }
    src = src.split("?")[0];

    if (!src) {
      continue;
    }

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
      // src = `data:image/jpg;base64,${Buffer.from(src).toString("base64")}`;
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

    if (!href) {
      continue;
    }
    href = href.split("?")[0];

    const u = new URL(tabUrl);
    const baseUrl = u.origin + "/";

    if (!href) {
      continue;
    } else if (href.startsWith("/") || href.startsWith("#")) {
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

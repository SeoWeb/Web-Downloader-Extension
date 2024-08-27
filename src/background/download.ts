import JSZip from "jszip";
import { getResources } from "./resources";
import { DOMParser } from "linkedom";

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
  const zip = new JSZip();
  const data = getResources(html);

  if (!tabUrl) {
    return;
  }

  const u = new URL(tabUrl || "");
  let zipFilename =
    u.pathname.split("/").slice(1).join("-") + `${Date.now()}.zip`;

  if (downloadOptions.downloadHTML) {
    sendMessage("Creating index.html");
    await addIndexHtml(html, zip, tabUrl);
    sendMessage("Index.html created");
  }

  if (downloadOptions.downloadAssets) {
    sendMessage("Downloading CSS files");
    await addCssFiles(data.css, zip, tabUrl);
    sendMessage("CSS files downloaded");

    sendMessage("Downloading JS files");
    await addJsFiles(data.js, zip, tabUrl);
    sendMessage("JS files downloaded");
  }

  if (downloadOptions.downloadDocuments) {
    sendMessage("Downloading document files");
    await addDocumentFiles(data.documents, zip, tabUrl);
    sendMessage("Document files downloaded");
  }

  if (downloadOptions.downloadImages) {
    sendMessage("Downloading images");
    await addImageFiles(data.images, zip, tabUrl);
    sendMessage("Images downloaded");
  }

  if (downloadOptions.downloadLinks) {
    sendMessage("Downloading linked html files");
    await addHtmlFiles(data.links, zip, tabUrl);
    sendMessage("Linked html files downloaded");
  }

  if (downloadOptions.downloadContentAsText) {
    sendMessage("Downloading content as text");
    await addContentText(data.text, zip);
    sendMessage("Content as text downloaded");
  }

  let blob: any;

  if (downloadOptions.singleFile) {
    sendMessage("Creating index.html");
    const singleFileHtml = await convertToSingleFileHtml(html, tabUrl);
    blob = new Blob([singleFileHtml], { type: "text/html;charset=UTF-8" });
    zipFilename = zipFilename.replace(".zip", ".html");
  } else {
    blob = await zip.generateAsync({ type: "blob" });
  }

  const reader = new FileReader();
  reader.onloadend = function () {
    const base64data = (reader?.result as string)?.split(",")?.[1];
    chrome.downloads.download({
      url: "data:application/octet-stream;base64," + base64data,
      filename: zipFilename,
      saveAs: false,
    });
  };
  reader.readAsDataURL(blob);

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

async function addCssFiles(csss: string[], zip: JSZip, tabUrl: string) {
  if (!csss?.length) {
    return;
  }

  const zstyles = zip.folder("styles") || zip;

  for (const css of csss) {
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

    zstyles.file(filename, blob);
  }
}

async function addJsFiles(jss: string[], zip: JSZip, tabUrl: string) {
  if (!jss?.length) {
    return;
  }

  const zscripts = zip.folder("scripts") || zip;

  for (const js of jss) {
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

    zscripts.file(filename, blob);
  }
}

async function addDocumentFiles(
  documents: string[],
  zip: JSZip,
  tabUrl: string,
) {
  if (!documents?.length) {
    return;
  }

  const zdocuments = zip.folder("documents") || zip;

  for (const document of documents) {
    if (!document) {
      continue;
    }

    const u = new URL(document.startsWith("http") ? document : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(document, baseUrl);
    if (!response) {
      continue;
    }

    const blob = await response.blob();
    const filename = document.split("/").pop();

    if (!filename) {
      continue;
    }

    zdocuments.file(filename, blob);
  }
}

async function addImageFiles(images: string[], zip: JSZip, tabUrl: string) {
  if (!images?.length) {
    return;
  }

  const zimages = zip.folder("images") || zip;

  for (const image of images) {
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

    zimages.file(filename, blob);
  }
}

async function addHtmlFiles(links: string[], zip: JSZip, tabUrl: string) {
  if (!links?.length) {
    return;
  }

  const zhtmls = zip.folder("html") || zip;

  for (const link of links) {
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

    zhtmls.file(filename, html);
  }
}

async function fetchUrl(url: string, baseUrl: string) {
  if (!url) {
    return null;
  }

  const fullUrl = new URL(url, baseUrl).href;
  try {
    const response = await fetch(fullUrl);

    if (response.status >= 400) {
      return null;
    }

    return response;
  } catch (e) {
    return null;
  }
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

import React, { useState } from "react";
import JSZip from "jszip";
import { createRoot } from "react-dom/client";
import "./popup.css";

function convertScriptsToRelative(htmlString: string, baseUrl: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const scripts = doc.querySelectorAll("script[src]");

  for (const script of scripts) {
    let src: string | null = script.getAttribute("src");

    if (!src) {
      continue;
    } else if (src.startsWith("/") || src.startsWith("#")) {
      // Already relative, skip
    } else if (src.startsWith(baseUrl)) {
      const url = new URL(src, baseUrl);
      src = url.pathname + url.search + url.hash;
    }

    if (src.split(".").length > 1) {
      src = "./resources/" + src.split("/").pop();
    }

    script.setAttribute("src", src);
  }

  return doc.documentElement.outerHTML;
}

function convertStylesToRelative(htmlString: string, baseUrl: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const links = doc.querySelectorAll("link[rel='stylesheet']");

  for (const link of links) {
    let href: string | null = link.getAttribute("href");

    if (!href) {
      continue;
    } else if (href.startsWith("/") || href.startsWith("#")) {
      // Already relative, skip
    } else if (href.startsWith(baseUrl)) {
      const url = new URL(href, baseUrl);
      href = url.pathname + url.search + url.hash;
    }

    if (href.split(".").length > 1) {
      href = "./resources/" + href.split("/").pop();
    }

    link.setAttribute("href", href);
  }

  return doc.documentElement.outerHTML;
}

function convertImagesToRelative(htmlString: string, baseUrl: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const images = doc.querySelectorAll("img[src]");

  for (const image of images) {
    let src: string | null = image.getAttribute("src");

    if (!src) {
      continue;
    } else if (src.startsWith("/") || src.startsWith("#")) {
      // Already relative, skip
    } else if (src.startsWith(baseUrl)) {
      const url = new URL(src, baseUrl);
      src = url.pathname + url.search + url.hash;
    }

    if (src.split(".").length > 1) {
      src = "./resources/" + src.split("/").pop();
    }

    image.setAttribute("src", src);
  }

  return doc.documentElement.outerHTML;
}

function convertLinksToRelative(htmlString: string, baseUrl: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const links = doc.querySelectorAll("a[href]");

  for (const link of links) {
    let href: string | null = link.getAttribute("href");

    if (!href) {
      continue;
    } else if (href.startsWith("/") || href.startsWith("#")) {
      // Already relative, skip
    } else if (href.startsWith(baseUrl)) {
      const url = new URL(href, baseUrl);
      href = url.pathname + url.search + url.hash;
    } else {
      continue;
    }

    if (href.split(".").length > 1) {
      href = "./resources/" + href.split("/").pop();
    } else {
      href = "./" + href.split("/").pop() + ".html";
    }

    link.setAttribute("href", href);
  }

  return doc.documentElement.outerHTML;
}

async function fetchUrl(url: string, baseUrl: string) {
  const fullUrl = new URL(url, baseUrl).href;
  const response = await fetch(fullUrl);

  if (response.status >= 400) {
    return null;
  }

  return response;
}

async function downloadResources(urls: string[], tabUrl: string) {
  const zip = new JSZip();
  const u = new URL(tabUrl || "");
  const baseUrl = u.origin + "/";
  const zipFilename =
    u.pathname.split("/").slice(1).join("-") + `${Date.now()}.zip`;

  const response = await fetchUrl(tabUrl, baseUrl);
  if (!response) {
    console.error(`Failed to fetch base URL: ${baseUrl}`);
    return;
  }

  let html = convertLinksToRelative(await response.text(), baseUrl);
  if (html.includes("<base")) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const base = doc.querySelector("base");
    if (base) {
      base.remove();
      html = doc.documentElement.outerHTML;
    }
  }

  html = convertImagesToRelative(html, baseUrl);
  html = convertStylesToRelative(html, baseUrl);
  html = convertScriptsToRelative(html, baseUrl);
  const blob = new Blob([html], { type: "text/html" });

  zip.file("index.html", blob);

  for (const url of urls) {
    const response = await fetchUrl(url, baseUrl);
    if (!response) {
      console.error(`Failed to download resource: ${url}`);
      continue;
    }

    const blob = await response.blob();
    const filename = url.split("/").pop();

    if (!filename) {
      continue;
    }

    const resources = zip.folder("resources") || zip;

    if (filename.endsWith(".html")) {
      zip.file(filename, blob);
    } else if (filename.split(".").length === 1) {
      zip.file(filename + ".html", blob);
    } else {
      resources.file(filename, blob);
    }
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);

  const downloadLink = document.createElement("a");
  downloadLink.href = url;
  downloadLink.download = zipFilename;
  downloadLink.click();

  URL.revokeObjectURL(url);
}

const func = () => {
  const url = new URL(window.location.href || "");
  const baseUrl = url.origin + "/";
  const resources: string[] = [];

  const links = document.querySelectorAll(
    "link[rel='stylesheet'], script[src]",
  );
  links.forEach((link: any) => {
    if (
      !!link.href &&
      (link.href.startsWith("/") || link.href.startsWith(baseUrl))
    ) {
      resources.push(link.href.split("?")[0]);
    }
  });

  const scripts = document.querySelectorAll("script[src]");
  scripts.forEach((script: any) => {
    if (
      !!script.src &&
      (script.src.startsWith("/") || script.src.startsWith(baseUrl))
    ) {
      resources.push(script.src.split("?")[0]);
    }
  });

  const files = document.querySelectorAll("a[href]");
  files.forEach((file: any) => {
    if (
      !!file.href &&
      (file.href.startsWith("/") || file.href.startsWith(baseUrl))
    ) {
      resources.push(file.href.split("?")[0]);
    }
  });

  const images = document.querySelectorAll("img[src]");
  images.forEach((img: any) => {
    if (!!img.src && (img.src.startsWith("/") || img.src.startsWith(baseUrl))) {
      resources.push(img.src.split("?")[0]);
    }
  });

  return resources;
};

const Popup = () => {
  const [downloading, setDownloading] = useState<boolean>(false);
  const [tab, setTab] = useState<any>({});

  chrome.tabs
    .query({
      active: true,
      currentWindow: true,
    })
    .then((tabs) => {
      setTab(tabs[0]);
    });

  const handleClick = async () => {
    setDownloading(true);
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id || 0 },
        func,
      })
      .then(async (data: any) => {
        await downloadResources(data?.[0]?.result || [], tab.url || "");
        setDownloading(false);
      })
      .catch((error) => {
        console.error(error);
        setDownloading(false);
      });
  };

  return (
    <div className="p-6 min-w-[24rem] flex flex-col justify-start items-center">
      <h1 className="text-2xl text-black flex gap-2 items-center">
        <img
          src="/icons/32x32.png"
          alt="Web Page Downloader icon"
          className="size-8"
        />
        Web Page Downloader
      </h1>
      <div className="my-4 border border-sky-500 bg-sky-100 text-black p-4 rounded-lg">
        Click to initiate the download process for the current web page. The
        extension will save the page's HTML, along with all linked resources
        from the same domain (images, PDFs, documents, other pages), into a ZIP
        file for offline viewing.
      </div>
      <div className="p-4">
        <div className="text-xs font-bold">Current page url:</div>
        <div className="text-xs italic">{tab.url || ""}</div>
      </div>
      <button
        onClick={handleClick}
        disabled={downloading}
        className="bg-green-200 ring ring-green-800 text-black px-6 py-2 rounded-md font-bold hover:bg-green-300 disabled:bg-slate-300 disabled:ring-slate-500"
      >
        Download this page
      </button>
      {downloading && (
        <div className="mt-4 border border-red-500 bg-red-100 text-red-800 p-4 rounded-lg">
          I am currently working on assembling the zip file.
          <br />
          <strong>
            Please do not close this popup or the download will be interrupted.
          </strong>
          <br />
          The download will start automatically.
        </div>
      )}
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);

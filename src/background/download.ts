import JSZip from "jszip";
import { getResources } from "./resources";
// import { messageActions } from "../common/message";
import {
  addIndexHtml,
  addContentText,
  addCssFiles,
  addJsFiles,
  addDocumentFiles,
  addImageFiles,
  addHtmlFiles
} from "./fileHandlers";
import { convertToSingleFileHtml } from "./htmlUtils";

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
                saveAs: true,
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

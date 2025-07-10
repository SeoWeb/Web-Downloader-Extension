import { useState } from "react";
import { Checkbox } from "./Checkbox";
import { CheckedState } from "@radix-ui/react-checkbox";
import { Button } from "./Button";
import { trackDownload, cleanWebsiteUrl } from "../common/services/analyticsService";

export default function Filter({
  download,
  userId,
  tabUrl,
}: {
  download: (options: {
    downloadHTML: boolean;
    downloadImages: boolean;
    downloadLinks: boolean;
    downloadAssets: boolean;
    downloadContentAsText: boolean;
    downloadDocuments: boolean;
    singleFile: boolean;
  }) => void;
  userId: number | null;
  tabUrl: string;
}) {
  const [downloadHTML, setDownloadHTML] = useState(true);
  const [downloadImages, setDownloadImages] = useState(true);
  const [downloadLinks, setDownloadLinks] = useState(false);
  const [downloadAssets, setDownloadAssets] = useState(true);
  const [downloadContentAsText, setDownloadContentAsText] = useState(false);
  const [downloadDocuments, setDownloadDocuments] = useState(true);
  const [singleFile, setSingleFile] = useState(false);

  const handleDownload = async () => {
    const downloadOptions = {
      downloadHTML,
      downloadImages,
      downloadLinks,
      downloadAssets,
      downloadContentAsText,
      downloadDocuments,
      singleFile,
    };

    // Send analytics data immediately when download starts (before scraping begins)
    if (userId && tabUrl) {
      try {
        const cleanUrl = cleanWebsiteUrl(tabUrl);
        await trackDownload(userId, cleanUrl, downloadOptions);
      } catch (error) {
        // Continue with download even if analytics fails
      }
    }

    // Start the download process
    download(downloadOptions);
  };

  if (
    (!!downloadHTML ||
      !!downloadImages ||
      !!downloadLinks ||
      !!downloadAssets ||
      !!downloadContentAsText ||
      !!downloadDocuments) &&
    !!singleFile
  ) {
    setSingleFile(false);
  }

  if (
    !downloadHTML &&
    !downloadImages &&
    !downloadLinks &&
    !downloadAssets &&
    !downloadContentAsText &&
    !downloadDocuments &&
    !singleFile
  ) {
    setDownloadHTML(true);
    setDownloadImages(true);
    setDownloadAssets(true);
  }

  return (
    <div className="p-4 bg-white rounded-lg shadow-md">
      <h3 className="text-lg font-bold mb-4">
        Filter out what you want to download
      </h3>
      <div className="space-y-4">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadHTML"
            checked={downloadHTML}
            onCheckedChange={(checked: CheckedState) => {
              if (
                !checked &&
                !downloadImages &&
                !downloadLinks &&
                !downloadAssets &&
                !downloadContentAsText &&
                !downloadDocuments
              ) {
                setDownloadContentAsText(true);
              }
              setDownloadHTML(!!checked);
              if (!!checked) {
                setDownloadImages(true);
                setDownloadAssets(true);
              } else {
                setDownloadAssets(false);
                setDownloadLinks(false);
              }
            }}
          />
          <label
            htmlFor="downloadHTML"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Download HTML
          </label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadImages"
            checked={downloadImages}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadImages(!!checked)
            }
          />
          <label
            htmlFor="downloadImages"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Download images
          </label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadLinks"
            checked={downloadLinks}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadLinks(!!checked)
            }
          />
          <label
            htmlFor="downloadLinks"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Download links (saved as html files)
          </label>
        </div>
        {downloadLinks && (
          <div
            className={`bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mt-4`}
            role="alert"
          >
            <span className="block sm:inline pr-16">
              If you choose to download links, you have to take into account
              that the total download time can increase dramatically and the zip
              file can be significantly larger.
            </span>
            <button
              onClick={() => {
                setDownloadLinks(false);
              }}
              className="absolute top-0 bottom-0 right-0 px-4 py-3"
            >
              <span className="sr-only">Dismiss</span>
              <svg
                className="h-6 w-6 text-red-600"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        )}
        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadAssets"
            checked={downloadAssets}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadAssets(!!checked)
            }
          />
          <label
            htmlFor="downloadAssets"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Download assets (css, js)
          </label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadDocuments"
            checked={downloadDocuments}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadDocuments(!!checked)
            }
          />
          <label
            htmlFor="downloadDocuments"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Download documents (pdf, doc, etc.)
          </label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadContentAsText"
            checked={downloadContentAsText}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadContentAsText(!!checked)
            }
          />
          <label
            htmlFor="downloadContentAsText"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Download content as text
          </label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox
            id="singleFile"
            checked={singleFile}
            onCheckedChange={(checked: CheckedState) => {
              if (!!checked) {
                setDownloadHTML(false);
                setDownloadImages(false);
                setDownloadLinks(false);
                setDownloadAssets(false);
                setDownloadContentAsText(false);
                setDownloadDocuments(false);
              }
              setSingleFile(!!checked);
            }}
          />
          <label
            htmlFor="singleFile"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            Download in single HTML file
          </label>
        </div>
      </div>
      <Button className="mt-4" onClick={handleDownload}>
        Start download
      </Button>
    </div>
  );
}

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "./Checkbox";
import { CheckedState } from "@radix-ui/react-checkbox";
import { Button } from "./Button";

import {
  useFilterOptions,
  useDownloadOptions,
  useStorageStatus,
} from "../hooks/useFilterOptions";
import { StoragePermissionBanner } from "./StoragePermissionBanner";
import { OffscreenPermissionBanner } from "./OffscreenPermissionBanner";
import { hasStoragePermission } from "../common/permissions";
import { hasOffscreenPermission } from "../common/permissions";

export default function Filter({
  download,
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
  tabUrl: string;
}) {
  const { t } = useTranslation();
  const [showPermissionBanner, setShowPermissionBanner] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [hasOffscreenPerm, setHasOffscreenPerm] = useState<boolean | null>(
    null,
  );

  const {
    options,
    isLoading,
    setDownloadHTML,
    setDownloadImages,
    setDownloadLinks,
    setDownloadAssets,
    setDownloadContentAsText,
    setDownloadDocuments,
    setSingleFile,
  } = useFilterOptions();

  const downloadOptions = useDownloadOptions();
  const { isLoadingFromStorage } = useStorageStatus();

  // Check permissions on mount
  useEffect(() => {
    const checkPermissions = async () => {
      try {
        const storagePermission = await hasStoragePermission();
        setHasPermission(storagePermission);

        // Show banner if permission is not granted and we haven't shown it before
        if (
          !storagePermission &&
          !localStorage.getItem("storage-banner-dismissed")
        ) {
          setShowPermissionBanner(true);
        }

        const offscreenPermission = await hasOffscreenPermission();
        setHasOffscreenPerm(offscreenPermission);
      } catch (error) {
        console.error("Error checking permissions:", error);
        setHasPermission(false);
        setHasOffscreenPerm(false);
      }
    };

    checkPermissions();
  }, []);

  const handleDownload = async () => {
    // Start the download process
    download(downloadOptions);
  };

  const handleDownloadHTMLChange = (checked: CheckedState) => {
    const isChecked = !!checked;

    // If unchecking HTML and no other content is selected, enable text content
    if (
      !isChecked &&
      !options.downloadImages &&
      !options.downloadLinks &&
      !options.downloadAssets &&
      !options.downloadContentAsText &&
      !options.downloadDocuments
    ) {
      setDownloadContentAsText(true);
    }

    setDownloadHTML(isChecked);

    // If enabling HTML, also enable images and assets
    if (isChecked) {
      setDownloadImages(true);
      setDownloadAssets(true);
    } else {
      // If disabling HTML, also disable assets and links
      setDownloadAssets(false);
      setDownloadLinks(false);
    }
  };

  const handleSingleFileChange = (checked: CheckedState) => {
    const isChecked = !!checked;

    if (isChecked) {
      // If enabling single file, disable all other options
      setDownloadHTML(false);
      setDownloadImages(false);
      setDownloadLinks(false);
      setDownloadAssets(false);
      setDownloadContentAsText(false);
      setDownloadDocuments(false);
    }

    setSingleFile(isChecked);
  };

  const handleDownloadLinksChange = (checked: CheckedState) => {
    setDownloadLinks(!!checked);
  };

  const handlePermissionGranted = () => {
    setHasPermission(true);
    setShowPermissionBanner(false);
    // Trigger re-initialization of the store
    window.location.reload();
  };

  const handlePermissionDenied = () => {
    setShowPermissionBanner(false);
    localStorage.setItem("storage-banner-dismissed", "true");
  };

  const handleOffscreenPermissionGranted = () => {
    setHasOffscreenPerm(true);
  };

  // Show loading state while initializing from storage
  if (isLoading || isLoadingFromStorage) {
    return (
      <div className="p-4 bg-white rounded-lg shadow-md">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded mb-4"></div>
          <div className="space-y-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center space-x-2">
                <div className="h-4 w-4 bg-gray-200 rounded"></div>
                <div className="h-4 bg-gray-200 rounded flex-1"></div>
              </div>
            ))}
          </div>
          <div className="h-10 bg-gray-200 rounded mt-4"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-white rounded-lg shadow-md">
      {/* Offscreen Permission Banner */}
      {hasOffscreenPerm === false && (
        <OffscreenPermissionBanner
          onPermissionGranted={handleOffscreenPermissionGranted}
        />
      )}

      {/* Storage Permission Banner */}
      {showPermissionBanner && (
        <StoragePermissionBanner
          onPermissionGranted={handlePermissionGranted}
          onPermissionDenied={handlePermissionDenied}
        />
      )}

      {/* Storage Status Indicator */}
      {hasPermission === false && !showPermissionBanner && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
          <div className="flex items-center">
            <svg
              className="h-4 w-4 text-yellow-400 mr-2"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <span className="text-sm text-yellow-800">
              {t('filter.permissionWarning')}
            </span>
          </div>
        </div>
      )}

      <h3 className="text-lg font-bold mb-4">
        {t('filter.title')}
      </h3>
      <div className="space-y-4">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadHTML"
            checked={options.downloadHTML}
            onCheckedChange={handleDownloadHTMLChange}
            aria-label={t('filter.ariaDownloadHtml')}
          />
          <label
            htmlFor="downloadHTML"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {t('filter.downloadHTML')}
          </label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadImages"
            checked={options.downloadImages}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadImages(!!checked)
            }
            aria-label={t('filter.ariaDownloadImages')}
          />
          <label
            htmlFor="downloadImages"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {t('filter.downloadImages')}
          </label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadLinks"
            checked={options.downloadLinks}
            onCheckedChange={handleDownloadLinksChange}
            aria-label={t('filter.ariaDownloadLinks')}
          />
          <label
            htmlFor="downloadLinks"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {t('filter.downloadLinks')}
          </label>
        </div>

        {options.downloadLinks && (
          <div
            className={`bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mt-4`}
            role="alert"
          >
            <span className="block sm:inline pr-16">
              {t('filter.linksWarning')}
            </span>
            <button
              onClick={() => setDownloadLinks(false)}
              className="absolute top-0 bottom-0 right-0 px-4 py-3"
              aria-label={t('filter.ariaDismissWarning')}
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
            checked={options.downloadAssets}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadAssets(!!checked)
            }
            aria-label={t('filter.ariaDownloadAssets')}
          />
          <label
            htmlFor="downloadAssets"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {t('filter.downloadAssets')}
          </label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadDocuments"
            checked={options.downloadDocuments}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadDocuments(!!checked)
            }
            aria-label={t('filter.ariaDownloadDocuments')}
          />
          <label
            htmlFor="downloadDocuments"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {t('filter.downloadDocuments')}
          </label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="downloadContentAsText"
            checked={options.downloadContentAsText}
            onCheckedChange={(checked: CheckedState) =>
              setDownloadContentAsText(!!checked)
            }
            aria-label={t('filter.ariaDownloadContent')}
          />
          <label
            htmlFor="downloadContentAsText"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {t('filter.downloadContentAsText')}
          </label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox
            id="singleFile"
            checked={options.singleFile}
            onCheckedChange={handleSingleFileChange}
            aria-label={t('filter.ariaSingleFile')}
          />
          <label
            htmlFor="singleFile"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {t('filter.singleFile')}
          </label>
        </div>
      </div>

      <Button
        className="mt-4"
        onClick={handleDownload}
        disabled={hasOffscreenPerm === false}
        aria-label={t('filter.startDownload')}
      >
        {t('filter.startDownload')}
      </Button>
    </div>
  );
}

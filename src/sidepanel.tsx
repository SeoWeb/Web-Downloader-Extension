import React, { useState, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import "./styles/rtl.css"; // RTL support styles
import "./i18n/config"; // Initialize i18n
import { useTranslation } from "react-i18next";
import { MessageAction, messageActions } from "./common/message";
import { Message } from "./components/Actions";
import { MainContent } from "./sidepanel/components/MainContent";
import { DownloadStatus } from "./sidepanel/components/DownloadStatus";
import { DownloadComplete } from "./sidepanel/components/DownloadComplete";
import { useActiveTabInfo } from "./sidepanel/hooks/useActiveTabInfo"; // Added hook import
import { useMessageListener } from "./sidepanel/hooks/useMessageListener"; // Added hook import
import { useScrapingDownloader } from "./sidepanel/hooks/useScrapingDownloader"; // Added hook import
import { usePermissions } from "./common/hooks/usePermissions";
import { GlobalPermissionRequest } from "./common/components/GlobalPermissionRequest";
import { LanguageSwitcher } from "./components/LanguageSwitcher";

interface Options {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadDocuments: boolean;
  singleFile: boolean;
}

function ErrorFallback({
  error,
  resetErrorBoundary,
}: {
  error: Error;
  resetErrorBoundary: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div role="alert" className="p-4 bg-red-100 rounded">
      <p className="font-bold text-red-800">{t('app.error')}</p>
      <pre className="text-red-600">{error.message}</pre>
      <button
        onClick={resetErrorBoundary}
        className="mt-2 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
      >
        {t('app.tryAgain')}
      </button>
    </div>
  );
}

export default function SidePanel() {
  const { t } = useTranslation();
  const [tabId, setTabId] = useState<number>(0);
  const [tabUrl, setTabUrl] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([{ key: "status.waiting" }]);
  const [action, setAction] = useState<MessageAction | null>(null);
  const [links, setLinks] = useState<string[]>([]);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  // downloadResponse and scrollAttempts are now managed by useScrapingDownloader hook
  const [downloadOptions, setDownloadOptions] = useState<{
    downloadHTML: boolean;
    downloadImages: boolean;
    downloadLinks: boolean;
    downloadAssets: boolean;
    downloadContentAsText: boolean;
    downloadDocuments: boolean;
    singleFile: boolean;
  } | null>(null);

  // Use the permissions hook
  const {
    hasPermission,
    permissionRequesting,
    requestPermission,
    loading: permissionsLoading,
    error: permissionsError,
  } = usePermissions();

  // Use the custom hooks
  useActiveTabInfo({ setTabId, setTabUrl, setMessages });

  // Initialize useScrapingDownloader hook early so setDownloadResponse is available
  const { downloadResponse, setDownloadResponse, setScrollAttempts } =
    useScrapingDownloader({
      tabId,
      tabUrl,
      isScraping,
      setIsScraping,
      downloadOptions,
      setMessages,
    });

  // Memoize messageWorker to stabilize useMessageListener dependency
  const messageWorker = useCallback(
    async (action: MessageAction, data: any): Promise<any> => {
      switch (action) {
        case messageActions.PANEL_MESSAGE:
          setMessages((prev) => [...prev, data.message]);
          if (data.message?.options?.isPaused !== undefined) {
            setIsPaused(data.message.options.isPaused);
          }
          // Update completion based on message type if needed
          break;

        case messageActions.DOWNLOAD_COMPLETE:
          // Download actually completed - file was saved
          setMessages((prev) => [...prev, { key: "status.scraped" }]);
          setAction(messageActions.DOWNLOAD_DONE);
          setMessages((prev) => [...prev, { key: "status.creating" }]);
          setMessages((prev) => [...prev, { key: "status.complete" }]);
          // Store download ID for "Show in folder" functionality
          if (data.downloadId) {
            chrome.storage.local.set({ lastDownloadId: data.downloadId });
          }
          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);
          // Stop scraping state to show completion UI
          setIsScraping(false);
          break;

        case messageActions.DOWNLOAD_FAILED:
          // Download failed or was interrupted
          console.error("Download failed:", data);
          // Reset messages to connected status with error message
          setMessages([
            { key: "status.connected" },
            `Download failed: ${data.error || "Unknown error"}`,
          ]);
          setIsScraping(false);
          setAction(null);
          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);
          break;

        case messageActions.DOWNLOAD_CANCELLED:
          // User cancelled the download
          setMessages([{ key: "status.connected" }]);
          setIsScraping(false);
          setAction(null);
          setDownloadResponse(null);
          break;

        default:
          break;
      }
      return null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [setDownloadResponse],
  ); // Add setDownloadResponse to dependencies

  useMessageListener({ messageWorker });

  // Listen for download completion via chrome.storage
  useEffect(() => {
    // Only set up listener if we have storage permission
    if (!hasPermission) {
      return;
    }

    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === "local" && changes.downloadComplete) {
        const downloadComplete = changes.downloadComplete.newValue;
        if (downloadComplete) {
          setMessages((prev) => [...prev, { key: "status.scraped" }]);
          setAction(messageActions.DOWNLOAD_DONE);
          setMessages((prev) => [...prev, { key: "status.creating" }]);
          setMessages((prev) => [...prev, { key: "status.complete" }]);

          // Store download ID for "Show in folder" functionality
          if (downloadComplete.downloadId) {
            chrome.storage.local.set({ lastDownloadId: downloadComplete.downloadId });
          }

          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);

          // Stop scraping state to show completion UI
          setIsScraping(false);

          // Clear the downloadComplete flag
          chrome.storage.local.remove("downloadComplete");
        }
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);

    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [hasPermission, setMessages, setAction, setDownloadResponse, setIsScraping]);

  // Memoize reset function
  const reset = useCallback(
    (newTabUrl: string) => {
      setTabUrl(newTabUrl);
      setMessages([{ key: "status.waiting" }, { key: "status.connected" }]);
      setAction(null);
      setLinks([]);
      setIsScraping(false);
      setDownloadResponse(null); // Use setter from hook
      setScrollAttempts(0); // Use setter from hook
      setDownloadOptions(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [setDownloadResponse, setScrollAttempts],
  ); // Add setters from hook to dependencies

  // Memoize onClickStartDownload
  const onClickStartDownload = useCallback(async (options: Options) => {
    setIsScraping(true);
    setDownloadOptions(options);
    setMessages((prev) => [...prev, { key: "status.scraping" }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Keep dependencies minimal

  const resetError = useCallback(() => {
    setError(null);
    reset(tabUrl);
  }, [reset, tabUrl]);

  if (error) {
    return (
      <div className="p-6">
        <ErrorFallback error={error} resetErrorBoundary={resetError} />
      </div>
    );
  }

  // Show permission request if user doesn't have storage permission
  if (!hasPermission && !permissionsLoading) {
    return (
      <div className="p-6">
        <div className="mb-4 flex justify-end">
          <LanguageSwitcher />
        </div>
        <GlobalPermissionRequest
          onRequestPermission={requestPermission}
          requesting={permissionRequesting}
          error={permissionsError}
        />
      </div>
    );
  }

  // Show loading state while checking permissions
  if (permissionsLoading) {
    return (
      <div className="p-6 text-center">
        <div className="text-lg">{t('app.loading')}</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <MainContent
        messages={messages}
        tabId={tabId}
        isScraping={isScraping}
        action={action}
        downloadResponse={downloadResponse}
        onClickStartDownload={onClickStartDownload}
        tabUrl={tabUrl}
      />
      <DownloadStatus
        tabId={tabId}
        isScraping={isScraping}
        isPaused={isPaused}
        action={action}
        downloadResponse={downloadResponse}
        setIsScraping={setIsScraping}
      />
      <DownloadComplete
        tabId={tabId}
        tabUrl={tabUrl}
        links={links}
        action={action}
        reset={reset}
      />
    </div>
  );
}

// mergeDownloadResponse function removed (moved to utils)

const root = createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>,
);

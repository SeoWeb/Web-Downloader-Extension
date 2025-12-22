import React, { useState, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import { MessageAction, messageActions } from "./common/message";
import { MainContent } from "./sidepanel/components/MainContent";
import { DownloadStatus } from "./sidepanel/components/DownloadStatus";
import { DownloadComplete } from "./sidepanel/components/DownloadComplete";
import { useActiveTabInfo } from "./sidepanel/hooks/useActiveTabInfo"; // Added hook import
import { useMessageListener } from "./sidepanel/hooks/useMessageListener"; // Added hook import
import { useScrapingDownloader } from "./sidepanel/hooks/useScrapingDownloader"; // Added hook import
import { useGlobalUserId } from "./common/hooks/useGlobalUserId";
import { GlobalPermissionRequest } from "./common/components/GlobalPermissionRequest";

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
  return (
    <div role="alert" className="p-4 bg-red-100 rounded">
      <p className="font-bold text-red-800">Something went wrong:</p>
      <pre className="text-red-600">{error.message}</pre>
      <button
        onClick={resetErrorBoundary}
        className="mt-2 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
      >
        Try again
      </button>
    </div>
  );
}

export default function SidePanel() {
  const [tabId, setTabId] = useState<number>(0);
  const [tabUrl, setTabUrl] = useState<string>("");
  const [messages, setMessages] = useState<string[]>(["Waiting connection..."]);
  const [action, setAction] = useState<MessageAction | null>(null);
  const [links, setLinks] = useState<string[]>([]);
  const [isScraping, setIsScraping] = useState<boolean>(false);
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

  // Use the global user ID hook
  const {
    userId,
    loading: userIdLoading,
    error: userIdError,
    hasPermission,
    permissionRequesting,
    requestPermission,
  } = useGlobalUserId();

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
          // Update completion based on message type if needed
          break;

        case messageActions.DOWNLOAD_COMPLETE:
          // Download actually completed - file was saved
          console.log("Download completed:", data);
          setMessages((prev) => [...prev, "Website scraped!"]);
          setAction(messageActions.DOWNLOAD_DONE);
          setMessages((prev) => [...prev, "Zip file created!"]);
          setMessages((prev) => [...prev, "Download complete"]);
          // Store download ID for "Show in folder" functionality
          if (data.downloadId) {
            chrome.storage.local.set({ lastDownloadId: data.downloadId });
          }
          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);
          break;

        case messageActions.DOWNLOAD_FAILED:
          // Download failed or was interrupted
          console.error("Download failed:", data);
          setMessages((prev) => [
            ...prev,
            `Download failed: ${data.error || "Unknown error"}`,
          ]);
          setIsScraping(false);
          setAction(null);
          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);
          break;

        case messageActions.DOWNLOAD_CANCELLED:
          // User cancelled the download
          console.log("Download cancelled:", data);
          setMessages((prev) => [...prev, "Download was cancelled"]);
          setIsScraping(false);
          setAction(null);
          // Reset downloadResponse to allow filter to show again
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
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === "local" && changes.downloadComplete) {
        const downloadComplete = changes.downloadComplete.newValue;
        if (downloadComplete) {
          console.log("Download completed via storage:", downloadComplete);
          setMessages((prev) => [...prev, "Website scraped!"]);
          setAction(messageActions.DOWNLOAD_DONE);
          setMessages((prev) => [...prev, "Zip file created!"]);
          setMessages((prev) => [...prev, "Download complete"]);
          
          // Store download ID for "Show in folder" functionality
          if (downloadComplete.downloadId) {
            chrome.storage.local.set({ lastDownloadId: downloadComplete.downloadId });
          }
          
          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);
          
          // Clear the downloadComplete flag
          chrome.storage.local.remove("downloadComplete");
        }
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);

    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [setMessages, setAction, setDownloadResponse]);

  // Memoize setDownloadDone to stabilize useScrapingDownloader dependency
  // const setDownloadDone = useCallback((newLinks: string[]) => {
  //   try {
  //     setLinks(newLinks);
  //     setMessages((prev) => [...prev, "Website scraped!"]);
  //     setAction(messageActions.DOWNLOAD_DONE);
  //     setMessages((prev) => [...prev, "Zip file created!"]);
  //     setMessages((prev) => [...prev, "Download complete"]);
  //   } catch (err) {
  //     console.error("Error in download completion:", err);
  //     setError(err instanceof Error ? err : new Error(String(err)));
  //     setMessages((prev) => [...prev, "Error completing download"]);
  //   }
  //   // eslint-disable-next-line react-hooks/exhaustive-deps
  // }, []); // Keep dependencies minimal, setLinks, setMessages, setAction are stable

  // Memoize reset function
  const reset = useCallback(
    (newTabUrl: string) => {
      setTabUrl(newTabUrl);
      setMessages(["Waiting connection...", "Website connected!"]);
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
    setMessages((prev) => [...prev, "Scraping website..."]);
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
  if (!hasPermission && !userIdLoading) {
    return (
      <div className="p-6">
        <GlobalPermissionRequest
          onRequestPermission={requestPermission}
          requesting={permissionRequesting}
          error={userIdError}
        />
      </div>
    );
  }

  // Show loading state while checking permissions/user ID
  if (userIdLoading) {
    return (
      <div className="p-6 text-center">
        <div className="text-lg">Loading...</div>
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
        userId={userId}
        tabUrl={tabUrl}
      />
      <DownloadStatus
        tabId={tabId}
        isScraping={isScraping}
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

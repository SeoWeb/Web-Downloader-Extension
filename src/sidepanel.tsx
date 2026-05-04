import React, { useState, useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import "./styles/rtl.css"; // RTL support styles
import "./i18n/config"; // Initialize i18n
import { useTranslation } from "react-i18next";
import { MessageAction, messageActions } from "./common/message";
import { Message } from "./components/Actions";
import { MainContent } from "./sidepanel/components/MainContent";
import { DownloadStatus, InterruptData } from "./sidepanel/components/DownloadStatus";
import { DownloadComplete } from "./sidepanel/components/DownloadComplete";
import { useActiveTabInfo } from "./sidepanel/hooks/useActiveTabInfo"; // Added hook import
import { useMessageListener } from "./sidepanel/hooks/useMessageListener"; // Added hook import
import { useScrapingDownloader } from "./sidepanel/hooks/useScrapingDownloader"; // Added hook import
import { usePermissions } from "./common/hooks/usePermissions";
import { GlobalPermissionRequest } from "./common/components/GlobalPermissionRequest";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { IS_SERVER_MODE } from "./common/server-mode";
import { sendMessageToBackground } from "./client/message";
import {
  ServerModeState,
  initialServerModeState,
  applyServerModeMessage,
} from "./sidepanel/server-mode-state";

// ServerModeState type and transition logic are imported from
// server-mode-state.ts to avoid duplication and enable unit testing.

// Keep track of blob URLs created by this side panel instance so they can be revoked later
const activeBlobUrls = new Map<number, string>();

const cleanupBlobUrl = (downloadId: number) => {
  const url = activeBlobUrls.get(downloadId);
  if (url) {
    URL.revokeObjectURL(url);
    activeBlobUrls.delete(downloadId);
  }
};

interface Options {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadDocuments: boolean;
  singleFile: boolean;
  alwaysAskWhereToSave?: boolean;
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
  const actionRef = useRef<MessageAction | null>(null);
  actionRef.current = action;
  const [links, setLinks] = useState<string[]>([]);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [isScrapingLinkedPages, setIsScrapingLinkedPages] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  // (15.1–15.7) Server-mode UI state
  const [serverModeState, setServerModeState] = useState<ServerModeState>(initialServerModeState);
  // Interrupt state: shown when the service worker was killed during a download
  const [interruptData, setInterruptData] = useState<InterruptData | null>(null);
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
  const { downloadResponse, lastHtml, setDownloadResponse, setScrollAttempts, stopScraping } =
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
        case messageActions.PANEL_PING:
          // Service worker is checking if we're alive
          return "PONG";

        case messageActions.PANEL_CREATE_DOWNLOAD: {
          // Service worker is asking us to create a blob URL and download a file.
          // This is needed because service workers can't use URL.createObjectURL,
          // and data URLs cause Chrome to ignore the filename parameter.
          try {
            const { getBlob, deleteBlob } = await import("./common/blobStorage");
            const blob = await getBlob(data.idbKey);

            const objectUrl = URL.createObjectURL(blob);

            try {
              const downloadId = await chrome.downloads.download({
                url: objectUrl,
                filename: data.filename,
                saveAs: data.saveAs ?? true,
                conflictAction: "uniquify",
              });

              // Store the objectUrl for cleanup when download completes
              activeBlobUrls.set(downloadId, objectUrl);

              // Clean up the temp blob from IndexedDB
              try {
                await deleteBlob(data.idbKey);
              } catch {
                // Non-critical cleanup error
              }

              return { downloadId };
            } catch (downloadError) {
              URL.revokeObjectURL(objectUrl);
              throw downloadError;
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            return { error: errorMessage };
          }
        }

        case messageActions.PANEL_MESSAGE:
          // Ignore messages from other tabs
          if (data.tabId !== undefined && data.tabId !== tabId) break;
          setMessages((prev) => [...prev, data.message]);
          if (data.message?.options?.isPaused !== undefined) {
            setIsPaused(data.message.options.isPaused);
          }
          // Track linked page scraping state based on message keys
          if (data.message?.key === "status.scrapingLinkedPages") {
            setIsScrapingLinkedPages(true);
          } else if (data.message?.key === "status.creatingPackage") {
            setIsScrapingLinkedPages(false);
          }

          // (15.7) Track server-mode phase transitions from messages.
          // Delegates to applyServerModeMessage() pure function (testable).
          if (IS_SERVER_MODE) {
            const msgKey = data.message?.key;
            if (msgKey) {
              setServerModeState((prev) =>
                applyServerModeMessage(prev, msgKey, data.message?.options),
              );
            }
          }
          // Update completion based on message type if needed
          break;

        case messageActions.DOWNLOAD_COMPLETE:
          if (data.tabId !== undefined && data.tabId !== tabId) break;
          if (data.downloadId) cleanupBlobUrl(data.downloadId);
          // Download actually completed - file was saved
          setMessages((prev) => [...prev, { key: "status.scraped" }]);
          setAction(messageActions.DOWNLOAD_DONE);
          setServerModeState((prev) => prev ? { ...prev, phase: 'ready' } : prev);
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
          setIsScrapingLinkedPages(false);
          break;

        case messageActions.DOWNLOAD_FAILED:
          if (data.tabId !== undefined && data.tabId !== tabId) break;
          if (data.downloadId) cleanupBlobUrl(data.downloadId);
          // Download failed or was interrupted
          // Reset messages to connected status with error message
          setMessages([
            { key: "status.connected" },
            { key: "status.failedWithError", options: { error: data.error || t("app.unknownError") } },
          ]);
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setAction(null);
          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);
          break;

        case messageActions.DOWNLOAD_CANCELLED:
          if (data.tabId !== undefined && data.tabId !== tabId) break;
          if (data.downloadId) cleanupBlobUrl(data.downloadId);
          // User cancelled the download
          setMessages([{ key: "status.connected" }]);
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setAction(null);
          setDownloadResponse(null);
          break;

        case messageActions.DOWNLOAD_INTERRUPTED:
          // Service worker was killed during an active download
          setInterruptData({
            phase: data.phase || "scraping",
            tabUrl: data.tabUrl || "",
            timestamp: data.timestamp || Date.now(),
            serverSessionId: data.serverSessionId,
            resourceUrls: data.resourceUrls,
          });
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setAction(null);
          setDownloadResponse(null);
          setMessages([
            { key: "status.connected" },
            { key: "status.downloadInterrupted", options: { phase: data.phase || "scraping" } },
          ]);
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

  // Check for interrupted downloads on panel open
  useEffect(() => {
    (async () => {
      try {
        const result = await sendMessageToBackground(messageActions.CHECK_INTERRUPTED_DOWNLOAD, {});
        if (result && result.downloadInterrupted) {
          setInterruptData({
            phase: result.phase || "scraping",
            tabUrl: result.tabUrl || "",
            timestamp: result.timestamp || Date.now(),
            serverSessionId: result.serverSessionId,
            resourceUrls: result.resourceUrls,
          });
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setMessages([
            { key: "status.connected" },
            { key: "status.downloadInterrupted", options: { phase: result.phase || "scraping" } },
          ]);
        }
      } catch {
        // Background not ready yet — ignore
      }
    })();
  }, []); // Run once on mount

  // Listen for download completion via chrome.storage
  useEffect(() => {
    // Only set up listener if we have storage permission
    if (!hasPermission) {
      return;
    }

    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === "local" && changes.downloadComplete) {
        const downloadComplete = changes.downloadComplete.newValue;
        if (downloadComplete && downloadComplete.tabId !== undefined && downloadComplete.tabId === tabId) {
          // Guard: skip if already handled via DOWNLOAD_COMPLETE message
          if (actionRef.current === messageActions.DOWNLOAD_DONE) {
            chrome.storage.local.remove("downloadComplete");
            return;
          }
          if (downloadComplete.downloadId) cleanupBlobUrl(downloadComplete.downloadId);
          setMessages((prev) => [...prev, { key: "status.scraped" }]);
          setAction(messageActions.DOWNLOAD_DONE);
          setServerModeState((prev) => prev ? { ...prev, phase: 'ready' } : prev);
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
          setIsScrapingLinkedPages(false);

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
      setIsScrapingLinkedPages(false);
      setDownloadResponse(null); // Use setter from hook
      setScrollAttempts(0); // Use setter from hook
      setDownloadOptions(null);
      setServerModeState(initialServerModeState); // Reset server-mode state
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [setDownloadResponse, setScrollAttempts],
  ); // Add setters from hook to dependencies

  // Memoize onClickStartDownload
  const onClickStartDownload = useCallback(async (options: Options) => {
    setAction(null);
    setInterruptData(null);
    setIsScraping(true);
    setDownloadOptions(options);
    setMessages((prev) => [...prev, { key: "status.scraping" }]);
    // (15.7) Track singleFile option in server-mode state
    if (IS_SERVER_MODE) {
      setServerModeState((prev) => ({ ...prev, phase: 'scraping', isSingleFile: options.singleFile }));
    }
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
        isScrapingLinkedPages={isScrapingLinkedPages}
        action={action}
        downloadResponse={downloadResponse}
        onClickStartDownload={onClickStartDownload}
        tabUrl={tabUrl}
      />
      <DownloadStatus
        tabId={tabId}
        isScraping={isScraping}
        isScrapingLinkedPages={isScrapingLinkedPages}
        isPaused={isPaused}
        action={action}
        downloadResponse={downloadResponse}
        onStopScraping={stopScraping}
        setIsPaused={setIsPaused}
        serverModeState={IS_SERVER_MODE ? serverModeState : undefined}
        onRetryServer={() => {
          // Re-trigger download with same options — reset all server
          // session refs so a fresh session is created on retry.
          if (downloadOptions) {
            setDownloadResponse(null);
            setScrollAttempts(0);
            setIsScraping(true);
            setMessages((prev) => [...prev, { key: "status.scraping" }]);
            setServerModeState((prev) => ({ ...prev, phase: 'scraping', serverError: null }));
          }
        }}
        onLocalFallback={() => {
          // Send SERVER_LOCAL_FALLBACK message to background to re-run in local mode
          sendMessageToBackground(messageActions.SERVER_LOCAL_FALLBACK, {
              tabId,
              tabUrl,
              html: lastHtml || downloadResponse?.html,
              downloadOptions,
            });
          setServerModeState(initialServerModeState);
        }}
        onDownloadFromServer={async () => {
          if (serverModeState.serverDownloadUrl) {
            const { loadFilterOptions } = await import("./common/storage/filterStorage");
            const opts = await loadFilterOptions();
            chrome.downloads.download({
              url: serverModeState.serverDownloadUrl,
              saveAs: opts.alwaysAskWhereToSave ?? true,
            });
          }
        }}
        interruptData={interruptData}
        onRestartDownload={async () => {
          setInterruptData(null);
          // If server mode and we have a server session ID, attempt resume
          if (IS_SERVER_MODE && interruptData?.serverSessionId) {
            setIsScraping(true);
            setMessages((prev) => [...prev, { key: "status.reconnectingServer" }]);
            setServerModeState((prev) => ({ ...prev, phase: 'uploading', serverError: null }));
            try {
              const result = await sendMessageToBackground(messageActions.RESUME_SERVER_DOWNLOAD, {
                serverSessionId: interruptData.serverSessionId,
                tabUrl: interruptData.tabUrl,
                phase: interruptData.phase,
                resourceUrls: interruptData.resourceUrls,
              });
              if (result?.fallback) {
                // Resume failed — fall through to full restart
                throw new Error(result.error || "Resume failed");
              }
              // Resume succeeded — update state
              setIsScraping(false);
              setAction(messageActions.DOWNLOAD_DONE);
            } catch {
              // Resume failed — fall back to full restart
              if (downloadOptions) {
                setIsScraping(true);
                setDownloadOptions(downloadOptions);
                setMessages((prev) => [...prev, { key: "status.scraping" }]);
                setServerModeState((prev) => ({ ...prev, phase: 'scraping', serverError: null }));
              }
            }
          } else if (downloadOptions) {
            setIsScraping(true);
            setDownloadOptions(downloadOptions);
            setMessages((prev) => [...prev, { key: "status.scraping" }]);
            if (IS_SERVER_MODE) {
              setServerModeState((prev) => ({ ...prev, phase: 'scraping', serverError: null }));
            }
          }
        }}
        onDismissInterrupt={() => {
          setInterruptData(null);
          setMessages([{ key: "status.connected" }]);
          // Clear the checkpoint so re-opening the panel doesn't show stale state
          sendMessageToBackground(messageActions.DISMISS_INTERRUPTED_DOWNLOAD, {});
        }}
      />
      <DownloadComplete
        tabId={tabId}
        tabUrl={tabUrl}
        links={links}
        action={action}
        reset={reset}
        serverDownloadUrl={IS_SERVER_MODE ? serverModeState.serverDownloadUrl : undefined}
        isSingleFile={IS_SERVER_MODE ? serverModeState.isSingleFile : undefined}
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

import React, { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import { MessageAction, messageActions } from "./common/message";
import { MainContent } from "./sidepanel/components/MainContent";
import { DownloadStatus } from "./sidepanel/components/DownloadStatus";
import { DownloadComplete } from "./sidepanel/components/DownloadComplete";
import { useActiveTabInfo } from "./sidepanel/hooks/useActiveTabInfo"; // Added hook import
import { useMessageListener } from "./sidepanel/hooks/useMessageListener"; // Added hook import
import { useScrapingDownloader } from "./sidepanel/hooks/useScrapingDownloader"; // Added hook import

interface Options {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadDocuments: boolean;
  singleFile: boolean;
}

function ErrorFallback({error, resetErrorBoundary}: {error: Error, resetErrorBoundary: () => void}) {
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

  // Use the custom hooks
  useActiveTabInfo({ setTabId, setTabUrl, setMessages });

  // Memoize messageWorker to stabilize useMessageListener dependency
  const messageWorker = useCallback(async (action: MessageAction, data: any): Promise<any> => {
    switch (action) {
      case messageActions.PANEL_MESSAGE:
        setMessages((prev) => [...prev, data.message]);
        // Update completion based on message type if needed
        break;

      default:
        break;
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Keep dependencies minimal, setMessages is stable

  useMessageListener({ messageWorker });

  // Memoize setDownloadDone to stabilize useScrapingDownloader dependency
  const setDownloadDone = useCallback((newLinks: string[]) => {
    try {
      setLinks(newLinks);
      setMessages((prev) => [...prev, "Website scraped!"]);
      setAction(messageActions.DOWNLOAD_DONE);
      setMessages((prev) => [...prev, "Zip file created!"]);
      setMessages((prev) => [...prev, "Download complete"]);
    } catch (err) {
      console.error("Error in download completion:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      setMessages((prev) => [...prev, "Error completing download"]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Keep dependencies minimal, setLinks, setMessages, setAction are stable

  const { downloadResponse, setDownloadResponse, setScrollAttempts } = useScrapingDownloader({
    tabId,
    tabUrl,
    isScraping,
    setIsScraping,
    downloadOptions,
    setMessages,
    setDownloadDone,
  });

  // Memoize reset function
  const reset = useCallback((newTabUrl: string) => {
    setTabUrl(newTabUrl);
    setMessages(["Waiting connection...", "Website connected!"]);
    setAction(null);
    setLinks([]);
    setIsScraping(false);
    setDownloadResponse(null); // Use setter from hook
    setScrollAttempts(0);    // Use setter from hook
    setDownloadOptions(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setDownloadResponse, setScrollAttempts]); // Add setters from hook to dependencies

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

  return (
    <div className="p-6">
      <MainContent
        messages={messages}
        tabId={tabId}
        isScraping={isScraping}
        action={action}
        downloadResponse={downloadResponse}
        onClickStartDownload={onClickStartDownload}
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

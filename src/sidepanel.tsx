import React, { useState, useCallback } from "react"; // Removed useEffect, added useCallback
import { createRoot } from "react-dom/client";
import "./popup.css";
// Removed sendMessageToBackground (handled in hooks)
import { MessageAction, messageActions } from "./common/message";
import Heading from "./components/Heading";
import Actions from "./components/Actions";
// Removed mergeHtml import
import { Button } from "./components/Button";
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

const ChromeExtensionRating = React.lazy(
  () => import("./components/ChromeExtensionRating"),
);
const Filter = React.lazy(() => import("./components/Filter"));

export default function SidePanel() {
  const [tabId, setTabId] = useState<number>(0);
  const [tabUrl, setTabUrl] = useState<string>("");
  const [messages, setMessages] = useState<string[]>(["Waiting connection..."]);
  const [action, setAction] = useState<MessageAction | null>(null);
  const [links, setLinks] = useState<string[]>([]);
  const [isScraping, setIsScraping] = useState<boolean>(false);
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
    setLinks(newLinks);
    setMessages((prev) => [...prev, "Website scraped!"]);
    setAction(messageActions.DOWNLOAD_DONE);
    setMessages((prev) => [...prev, "Zip file created!"]);
    setMessages((prev) => [...prev, "Download complete"]);
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

  return (
    <div className="p-6">
      <Heading />
      <Actions messages={messages} />

      {!!tabId &&
        !isScraping &&
        action !== messageActions.DOWNLOAD_DONE &&
        !downloadResponse?.html && (
          <div className="pt-8">
            <React.Suspense>
              <Filter download={onClickStartDownload} />
            </React.Suspense>
          </div>
        )}

      {!!tabId &&
        !isScraping &&
        action !== messageActions.DOWNLOAD_DONE &&
        !!downloadResponse?.html && (
          <div className="pt-8">
            <h3 className="pb-2 font-bold">Downloading website content ...</h3>
          </div>
        )}

      {!!tabId && isScraping && (
        <div className="pt-8">
          <h3 className="pb-2 font-bold">Scraping...</h3>
          <Button onClick={() => setIsScraping(false)} variant={"secondary"}>
            Stop
          </Button>
        </div>
      )}

      {action === messageActions.DOWNLOAD_DONE && (
        <div className="pt-8">
          <div className="pb-2 font-bold">Download is complete:</div>
          <div className="pb-4">
            You can find the zip file in your downloads folder
          </div>
          <div className="pb-4">
            <h3 className="pb-4 font-bold">
              If you were satisfied, please leave a positive review :)
            </h3>
            <React.Suspense>
              <ChromeExtensionRating />
            </React.Suspense>
          </div>
          <div className="pb-2 font-bold">Other links to download:</div>
          <div className="pb-2 flex flex-col gap-0 justify-start">
            {links
              .filter(
                (link) =>
                  !!link && link !== "" && link !== "/" && link !== "/#",
              )
              .map((link, index) => (
                <Button
                  key={index}
                  className="pb-2"
                  variant="link"
                  onClick={() => {
                    const u = new URL(tabUrl);
                    const baseUrl = u.origin + "/";
                    const url = new URL(link, baseUrl);
                    chrome.tabs.update(tabId, { url: url.href }, () => {
                      reset(url.href);
                    });
                  }}
                >
                  {link}
                </Button>
              ))}
          </div>
        </div>
      )}
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

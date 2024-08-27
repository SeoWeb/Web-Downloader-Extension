import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getActiveTab, listenMessage } from "./common/chrome";
import "./popup.css";
import { sendMessageToBackground } from "./client/message";
import { MessageAction, messageActions } from "./common/message";
import Heading from "./components/Heading";
import Actions from "./components/Actions";
import { mergeHtml } from "./background/merge-html";
import { Button } from "./components/Button";

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
  const [downloadResponse, setDownloadResponse] = useState<any>(null);
  const [scrollAttempts, setScrollAttempts] = useState<number>(0);
  const [downloadOptions, setDownloadOptions] = useState<{
    downloadHTML: boolean;
    downloadImages: boolean;
    downloadLinks: boolean;
    downloadAssets: boolean;
    downloadContentAsText: boolean;
    downloadDocuments: boolean;
    singleFile: boolean;
  } | null>(null);

  function reset(tabUrl: string) {
    setTabUrl(tabUrl);
    setMessages(["Waiting connection...", "Website connected!"]);
    setAction(null);
    setLinks([]);
    setIsScraping(false);
    setDownloadResponse(null);
    setScrollAttempts(0);
    setDownloadOptions(null);
  }

  useEffect(() => {
    async function startScrolling() {
      return await sendMessageToBackground(messageActions.START_SCROLL, {
        tabId,
      });
    }

    async function startDownload(html: string) {
      const addMessage = (message: string) =>
        setMessages((prev) => [...prev, message]);
      return await sendMessageToBackground(messageActions.START_DOWNLOAD, {
        tabId,
        html,
        tabUrl,
        downloadOptions,
        addMessage,
      });
    }

    async function scrape() {
      const response = await startScrolling();

      if (response && response.height && response.html) {
        setDownloadResponse((prev: any) => {
          const prevTop = prev?.top || 0;
          const data = mergeDownloadResponse(prev, response);

          if (response.top === prevTop) {
            // download starts
            setIsScraping(false);
          } else {
            setScrollAttempts((prev) => prev + 1);
          }

          return data;
        });
      }
    }

    if (isScraping) {
      scrape();
    } else if (!!downloadResponse?.html && !!downloadOptions) {
      startDownload(downloadResponse.html).then((links) => {
        setDownloadDone(links || []);
      });
    }
  }, [isScraping, scrollAttempts, downloadResponse?.height]);

  useEffect(() => {
    listenMessage(async (message, _addMessage) => {
      const action = message.action;
      const data = message.data;
      return messageWorker(action, data);
    }, "side-panel");
  }, []);

  useEffect(() => {
    if (action === null) {
      getActiveTab().then((tab) => {
        if (tab) {
          setTabId(tab.id);
          setTabUrl(tab.url);
          setMessages((prev) => [...prev, "Website connected!"]);
        }
      });
    }
  }, []);

  function setDownloadDone(links: string[]) {
    setLinks(links);
    setMessages((prev) => [...prev, "Website scraped!"]);
    setAction(messageActions.DOWNLOAD_DONE);
    setMessages((prev) => [...prev, "Zip file created!"]);
    setMessages((prev) => [...prev, "Download complete"]);
  }

  async function messageWorker(action: MessageAction, data: any): Promise<any> {
    switch (action) {
      case messageActions.PANEL_MESSAGE:
        setMessages((prev) => [...prev, data.message]);
        break;

      default:
        break;
    }

    return null;
  }

  const onClickStartDownload: (options: {
    downloadHTML: boolean;
    downloadImages: boolean;
    downloadLinks: boolean;
    downloadAssets: boolean;
    downloadContentAsText: boolean;
    downloadDocuments: boolean;
    singleFile: boolean;
  }) => Promise<void> = async (options) => {
    setIsScraping(true);
    setDownloadOptions(options);
    setMessages((prev) => [...prev, "Scraping website..."]);
  };

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

function mergeDownloadResponse(prev: any, response: any) {
  let html = "";

  if (!!prev?.html?.length && prev.height !== response.height) {
    html = mergeHtml(prev.html, response.html);
  } else {
    html = response.html;
  }

  return {
    html,
    top: response.top,
    height: response.height,
  };
}

const root = createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>,
);

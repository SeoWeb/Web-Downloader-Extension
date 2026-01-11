import { sendMessageToBackground } from "../../client/message";
import { messageActions } from "../../common/message";
import { DownloadOptions } from "../hooks/useScrapingDownloader";

export async function handleStartScroll(
  tabId: number,
  setMessages: (message: any) => void,
  setIsScraping: (value: boolean) => void,
): Promise<{ height?: number; html?: string; top?: number } | undefined> {
  try {
    const response = await sendMessageToBackground(
      messageActions.START_SCROLL,
      {
        tabId,
      },
    );
    return response;
  } catch (error) {
    console.error("Scroll failed:", error);
    setMessages({ key: "status.failedToStartScrolling" });
    setIsScraping(false);
    return undefined;
  }
}

export async function handleStartDownload(
  tabId: number,
  html: string,
  tabUrl: string,
  downloadOptions: DownloadOptions | null,
  setMessages: (message: any) => void,
): Promise<string[] | undefined> {
  try {
    const addMessage = (message: string) => {
      setMessages(message);
    };
    const response = await sendMessageToBackground(
      messageActions.START_DOWNLOAD,
      {
        tabId,
        html,
        tabUrl,
        downloadOptions,
        addMessage,
      },
    );
    return response;
  } catch (error) {
    console.error("Download failed:", error);
    setMessages({ key: "status.failed" });
    return undefined;
  }
}

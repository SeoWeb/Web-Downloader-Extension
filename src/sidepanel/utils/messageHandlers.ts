import { sendMessageToBackground } from "../../client/message";
import { messageActions } from "../../common/message";
import { DownloadOptions } from "../hooks/useScrapingDownloader";

export async function handleStartScroll(
  tabId: number,
  setMessages: (message: string) => void,
  setIsScraping: (value: boolean) => void
): Promise<{ height?: number; html?: string; top?: number } | undefined> {
  try {
    console.log("Sending START_SCROLL message for tab", tabId);
    const response = await sendMessageToBackground(messageActions.START_SCROLL, {
      tabId,
    });
    console.log("Received scroll response:", response);
    return response;
  } catch (error) {
    console.error("Scroll failed:", error);
    setMessages("Failed to start scrolling");
    setIsScraping(false);
    return undefined;
  }
}

export async function handleStartDownload(
  tabId: number,
  html: string,
  tabUrl: string,
  downloadOptions: DownloadOptions | null,
  setMessages: (message: string) => void
): Promise<string[] | undefined> {
  try {
    console.log("Sending START_DOWNLOAD message for tab", tabId);
    const addMessage = (message: string) => {
      console.log("Download progress:", message);
      setMessages(message);
    };
    const response = await sendMessageToBackground(messageActions.START_DOWNLOAD, {
      tabId,
      html,
      tabUrl,
      downloadOptions,
      addMessage,
    });
    console.log("Download completed with response:", response);
    return response;
  } catch (error) {
    console.error("Download failed:", error);
    setMessages("Download failed");
    return undefined;
  }
}
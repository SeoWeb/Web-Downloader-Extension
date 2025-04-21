import { sendMessageToBackground } from "../../client/message";
import { messageActions } from "../../common/message";
import { DownloadOptions } from "../hooks/useScrapingDownloader";

export async function handleStartScroll(
  tabId: number,
  setMessages: (message: string) => void,
  setIsScraping: (value: boolean) => void
): Promise<{ height?: number; html?: string; top?: number } | undefined> {
  try {
    return await sendMessageToBackground(messageActions.START_SCROLL, {
      tabId,
    });
  } catch (error) {
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
    const addMessage = (message: string) => setMessages(message);
    return await sendMessageToBackground(messageActions.START_DOWNLOAD, {
      tabId,
      html,
      tabUrl,
      downloadOptions,
      addMessage,
    });
  } catch (error) {
    setMessages("Download failed");
    return undefined;
  }
}
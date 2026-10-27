import { sendMessageToBackground } from "../../client/message";
import { messageActions } from "../../common/message";
import { DownloadOptions } from "../hooks/useScrapingDownloader";

export async function handleStartScroll(
  tabId: number,
  setMessages: (message: any) => void,
  setIsScraping: (value: boolean) => void,
): Promise<
  | {
      height?: number;
      html?: string;
      top?: number;
      heightChanged?: boolean;
      hydrationElapsedMs?: number;
      imagesPending?: number;
    }
  | undefined
> {
  try {
    const response = await sendMessageToBackground(
      messageActions.START_SCROLL,
      {
        tabId,
      },
    );
    return response;
  } catch {
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
  onFailure?: (error?: string) => void,
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
    // (Round 9 — Fix 4) A background-side rejection does NOT reject this
    // promise: the message channel resolves it as { success: false, error }
    // (common/chrome.ts listenMessage catch). This is the one terminal
    // failure signal that cannot be dropped by the panel's tab filter —
    // surface it instead of ignoring the response.
    if (
      response &&
      typeof response === "object" &&
      response.success === false
    ) {
      if (response.error) {
        setMessages({
          key: "status.failedWithError",
          options: { error: response.error },
        });
      } else {
        setMessages({ key: "status.failed" });
      }
      onFailure?.(response.error);
      return undefined;
    }
    return response;
  } catch {
    setMessages({ key: "status.failed" });
    return undefined;
  }
}

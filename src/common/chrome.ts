import { sendMessageToPanel } from "../background/message";
import { MessageAction } from "./message";

/**
 * Execute a script in a tab and return the first truthy frame result.
 *
 * Failure modes (D8 / task 1.4):
 * - When `chrome.scripting.executeScript` rejects (restricted pages like
 *   chrome://, the PDF viewer, the Web Store, or crashed tabs), the returned
 *   promise REJECTS — callers treat this as a bounded stop condition instead
 *   of hanging forever.
 * - When injection succeeds but every frame result is falsy, the promise
 *   resolves with `{ success: false, error }` so the scraping loop stops with
 *   a clear outcome.
 */
export async function executeScript(
  activeTabId: number,
  func: (...args: any) => any,
  args: [] = [],
): Promise<any> {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    func,
    args,
  });

  for (const frameResult of injectionResults ?? []) {
    if (frameResult && frameResult.result) {
      return frameResult.result;
    }
  }

  // Injection ran but produced no usable result — resolve with a bounded
  // failure instead of leaving the caller waiting.
  return {
    success: false,
    error: "Script injection returned no usable result",
  };
}

export async function getActiveTab(): Promise<{
  id: number;
  url: string;
} | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0) {
    const activeTab = tabs[0];
    if (
      activeTab?.id &&
      activeTab.url &&
      activeTab.url !== "about:blank" &&
      !activeTab.url.startsWith("chrome://")
    ) {
      return { id: activeTab.id, url: activeTab.url };
    }
  }
  return null;
}

type Message = {
  action: MessageAction;
  data: any;
};

let i: any = null;
export async function sendMessage(
  target: string,
  message: Message,
  force: boolean = true,
) {
  if (i) {
    clearTimeout(i);
  }

  const fn = async () => {
    return await chrome.runtime.sendMessage({
      target,
      message,
    });
  };

  if (force) {
    return await fn();
  }

  return new Promise<any>((resolve, reject) => {
    i = setTimeout(() => {
      fn().then(resolve).catch(reject);
    }, 1000);
  });
}

interface ListenerMessage {
  target: string;
  message: Message;
}
type ListenerFn = (
  message: ListenerMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
) => void;

export function listenMessage(
  callback: (
    message: Message,
    addMessage: (message: Message) => void,
  ) => Promise<void>,
  target: string,
): () => void {
  const listener: ListenerFn = (message, _sender, sendResponse) => {
    if (message.target === target) {
      const tabId = (message.message as Message)?.data?.tabId;
      callback(message.message as Message, (message: Message) => {
        return sendMessageToPanel(message.action, message.data, true, tabId);
      })
        .then(sendResponse)
        .catch((err) => {
          // A closed panel makes every sendMessage reject — log and swallow
          // so fire-and-forget progress pushes never become unhandled
          // rejections (D9 / task 4.4). Also answer the caller so a
          // rejecting action (e.g. executeScript on a restricted page)
          // surfaces as a bounded error instead of hanging the channel.
          console.debug(
            "[listenMessage] message handling failed:",
            err instanceof Error ? err.message : err,
          );
          try {
            sendResponse({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          } catch {
            // Channel already closed — nothing to do
          }
        });
      return true; // Only return true if we're handling this message
    }
    // Don't return true if the message isn't for us
    return false;
  };

  chrome.runtime.onMessage.addListener(listener);

  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}

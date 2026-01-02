import { sendMessageToPanel } from "../background/message";
import { MessageAction } from "./message";

export async function executeScript(
  activeTabId: number,
  func: (...args: any) => any,
  args: [] = [],
) {
  return new Promise<any>((resolve) => {
    chrome.scripting
      .executeScript({
        target: { tabId: activeTabId },
        func,
        args,
      })
      .then((injectionResults) => {
        for (const frameResult of injectionResults) {
          if (frameResult && frameResult.result) {
            resolve(frameResult.result);
            break;
          }
        }
      });
  });
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

  return new Promise<any>((resolve) => {
    i = setTimeout(() => {
      fn().then(resolve);
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
      callback(message.message as Message, (message: Message) => {
        sendMessageToPanel(message.action, message.data, true);
      }).then(sendResponse);
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

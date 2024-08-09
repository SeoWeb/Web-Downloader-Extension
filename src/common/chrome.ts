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

export function setBadge(text: string, color: string) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
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

export function listenMessage(
  callback: (message: Message) => Promise<void>,
  target: string,
) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target === target) {
      callback(message.message as Message).then(sendResponse);
    }

    // sendResponse({});
    return true;
  });
}

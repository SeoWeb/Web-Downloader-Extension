import { listenMessage } from "./src/common/chrome";
import { messageWorker } from "./src/background/message";

// Reset download state on startup and installation
const resetDownloadState = async () => {
  await chrome.storage.local.set({ isDownloadInProgress: false, downloads: {} });
  console.log('Download state reset.');
};

chrome.runtime.onStartup.addListener(resetDownloadState);
chrome.runtime.onInstalled.addListener(resetDownloadState);

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.setOptions(
    { tabId: tab.id, path: "sidePanel.html", enabled: true },
    () => {
      chrome.sidePanel.open({ tabId: tab.id });
    },
  );
});

listenMessage(async (message, addMessage) => {
  const action = message.action;
  const data = message.data;
  return await messageWorker(action, data, addMessage);
}, "background");

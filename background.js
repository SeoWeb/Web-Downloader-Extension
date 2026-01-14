import { listenMessage } from "./src/common/chrome";
import "./src/i18n/config-background"; // Use service worker-compatible i18n config

import { messageWorker } from "./src/background/message";
import { FileStore } from "./src/background/storage/file-store";

// Reset download state on startup and installation
const resetDownloadState = async () => {
  if (chrome.storage && chrome.storage.local) {
    await chrome.storage.local.set({ isDownloadInProgress: false, downloads: {} });
  }
  
  // Run IndexedDB cleanup
  try {
    await FileStore.cleanupOldDownloads();
  } catch {
    // ignore
  }
};

chrome.runtime.onStartup.addListener(resetDownloadState);
chrome.runtime.onInstalled.addListener(resetDownloadState);

// Run periodic cleanup (every 6 hours)
setInterval(async () => {
  try {
    await FileStore.cleanupOldDownloads();
  } catch {
    // ignore
  }
}, 6 * 60 * 60 * 1000);

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

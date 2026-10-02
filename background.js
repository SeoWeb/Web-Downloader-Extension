import { listenMessage } from "./src/common/chrome";
import "./src/i18n/config-background"; // Use service worker-compatible i18n config

import { messageWorker } from "./src/background/message";
import { readCheckpoint } from "./src/background/download-checkpoint";
import { messageActions } from "./src/common/message";

// Reset download state on startup and installation
const resetDownloadState = async () => {
  if (chrome.storage && chrome.storage.local) {
    await chrome.storage.local.set({ isDownloadInProgress: false, downloads: {} });
  }
};

chrome.runtime.onStartup.addListener(resetDownloadState);
chrome.runtime.onInstalled.addListener(resetDownloadState);

// On startup, check for a stale checkpoint from a previous download that was
// interrupted by a service worker restart. If found, attempt to notify any
// open panel so it can show the interrupt UI immediately. If no panel is
// listening (typical case), the message is silently dropped — the sidepanel
// also checks for interrupted downloads when it opens (pull-based fallback).
const notifyInterruptedDownload = async () => {
  try {
    const checkpoint = await readCheckpoint();
    if (checkpoint && checkpoint.downloadInterrupted) {
      try {
        await chrome.runtime.sendMessage({
          action: messageActions.DOWNLOAD_INTERRUPTED,
          data: {
            phase: checkpoint.phase,
            tabUrl: checkpoint.tabUrl,
            timestamp: checkpoint.timestamp,
            serverSessionId: checkpoint.serverSessionId,
            resourceUrls: checkpoint.resourceUrls,
          },
        });
      } catch {
        // No receiver — panel not open. Checkpoint persists for pull-based check on panel open.
      }
    }
  } catch {
    // ignore
  }
};

chrome.runtime.onStartup.addListener(notifyInterruptedDownload);

// Run periodic cleanup (every 6 hours)
setInterval(async () => {
  try {
    // Server-mode: no local IndexedDB cleanup needed
  } catch {
    // ignore
  }
}, 6 * 60 * 60 * 1000);

// Keepalive: receive ports from download-state.ts and send periodic pings
// to keep the service worker alive during long downloads.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "download-keepalive") {
    const pingInterval = setInterval(() => {
      try {
        port.postMessage({ type: "keepalive-ping" });
      } catch {
        clearInterval(pingInterval);
      }
    }, 25000);
    port.onDisconnect.addListener(() => {
      clearInterval(pingInterval);
    });
  }
});

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

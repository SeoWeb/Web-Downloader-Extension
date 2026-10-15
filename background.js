import { listenMessage } from "./src/common/chrome";
import "./src/i18n/config-background"; // Use service worker-compatible i18n config

import { messageWorker, sendMessageToPanel } from "./src/background/message";
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

// (Task 4.8) Open the built welcome page on first install only — not on update.
chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason === "install") {
    try {
      const welcomeUrl = chrome.runtime.getURL("welcome.html");
      const createResult = chrome.tabs.create({ url: welcomeUrl });
      // MV3 returns a promise — swallow failures (e.g. no window) so the
      // listener never produces an unhandled rejection.
      createResult?.catch?.((err) => {
        console.debug("[onInstalled] Failed to open welcome page:", err);
      });
    } catch (err) {
      console.debug("[onInstalled] Failed to open welcome page:", err);
    }
  }
});

// On startup, check for a stale checkpoint from a previous download that was
// interrupted by a service worker restart. If found, attempt to notify any
// open panel so it can show the interrupt UI immediately. If no panel is
// listening (typical case), the message is silently dropped — the sidepanel
// also checks for interrupted downloads when it opens (pull-based fallback).
const notifyInterruptedDownload = async () => {
  try {
    const checkpoint = await readCheckpoint();
    if (checkpoint && checkpoint.downloadInterrupted) {
      // (Task 4.4) Route through the enveloped helper — a raw
      // chrome.runtime.sendMessage({action, data}) without the
      // target: "side-panel" envelope is silently dropped by the panel.
      await sendMessageToPanel(
        messageActions.DOWNLOAD_INTERRUPTED,
        {
          phase: checkpoint.phase,
          tabUrl: checkpoint.tabUrl,
          timestamp: checkpoint.timestamp,
          serverSessionId: checkpoint.serverSessionId,
          resourceUrls: checkpoint.resourceUrls,
        },
        true,
        checkpoint.tabId,
      ).catch(() => {
        // No receiver — panel not open. Checkpoint persists for pull-based
        // check on panel open.
      });
    }
  } catch {
    // ignore
  }
};

chrome.runtime.onStartup.addListener(notifyInterruptedDownload);

// (Task 4.3) Periodic background cleanup moved to chrome.alarms — see
// src/background/cleanupHandlers.ts. setInterval timers never fire in an MV3
// service worker (the worker is suspended long before 6 hours elapse), so the
// previous 6-hour interval here was dead code and has been removed.

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

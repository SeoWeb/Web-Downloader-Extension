import { chromeStorage } from "../../common/chrome/storage";
import { MESSAGE_POPUP, MESSAGE_SIDEPANEL } from "../../types/message";
import { portOnMessageListener } from "./messageHandler";
import {
  clearPopupPort,
  clearSidePanelPort,
  getPopupMessageQueue,
  getSidePanelMessageQueue,
  setPopupPort,
  setSidePanelPort,
  shiftPopupMessageQueue,
  shiftSidePanelMessageQueue,
} from "./portManager";
import { askPopupStoreUpdate, askSidePanelStoreUpdate } from "./storeUpdater";

const sidePanelDisconnectedHandler = async () => {
  await chromeStorage.setPartialItem("download-status-storage", {
    isDownloading: false,
  });
  await chromeStorage.setPartialItem("download-settings-storage", {
    isSidePanelOpen: false,
  });
};

export const portOnDisconnectListener = async (port: chrome.runtime.Port) => {
  if (port.name === MESSAGE_POPUP) {
    clearPopupPort();
  } else if (port.name === MESSAGE_SIDEPANEL) {
    await sidePanelDisconnectedHandler();
    clearSidePanelPort();
  }
};

export const handleNewConnection = (port: chrome.runtime.Port) => {
  if (port.name === MESSAGE_POPUP) {
    setPopupPort(port);
    const queue = getPopupMessageQueue();
    while (queue.length > 0) {
      const queuedMessage = shiftPopupMessageQueue();
      if (queuedMessage) {
        port.postMessage(queuedMessage);
      }
    }
  } else if (port.name === MESSAGE_SIDEPANEL) {
    setSidePanelPort(port);
    const queue = getSidePanelMessageQueue();
    while (queue.length > 0) {
      const queuedMessage = shiftSidePanelMessageQueue();
      if (queuedMessage) {
        port.postMessage(queuedMessage);
      }
    }
  }
};

export const handlePortSpecificInitialization = async (
  port: chrome.runtime.Port,
) => {
  if (port.name === MESSAGE_SIDEPANEL) {
    await askSidePanelStoreUpdate(port);
  } else if (port.name === MESSAGE_POPUP) {
    await askPopupStoreUpdate(port);
  }
};

export const initializePortListeners = (port: chrome.runtime.Port) => {
  port.onMessage.addListener(portOnMessageListener);
  port.onDisconnect.addListener(portOnDisconnectListener);
};

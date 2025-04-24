import { sendMessage } from "../../common/chrome";
import { chromeStorage } from "../../common/chrome/storage";

const stopDownloading = async () => {
  await chromeStorage.setPartialItem("download-status-storage", {
    isDownloading: false
  });
};

const askPopupStoreUpdate = async () => {
  sendMessage({
    action: "updateStore",
    target: "popup",
  });
};

const askSidePanelStoreUpdate = async () => {
  sendMessage({
    action: "updateStore",
    target: "sidepanel",
  });
};

const sidePanelOpenListener = (port: chrome.runtime.Port) => {
  if (port.name === "sidepanel") {
    askSidePanelStoreUpdate();
    port.onDisconnect.addListener(async () => {
      stopDownloading();
      askPopupStoreUpdate();
    });
  }
};

export const connectListener = (port: chrome.runtime.Port) => {
  sidePanelOpenListener(port);
};

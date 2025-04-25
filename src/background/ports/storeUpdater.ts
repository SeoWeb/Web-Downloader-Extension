import {
  Message,
  MESSAGE_POPUP,
  MESSAGE_SIDEPANEL,
  MESSAGE_UPDATE_STORE,
} from "../../types/message";

export const askPopupStoreUpdate = async (port: chrome.runtime.Port) => {
  const message: Message = {
    action: MESSAGE_UPDATE_STORE,
    target: MESSAGE_POPUP,
    sender: MESSAGE_SIDEPANEL,
  };
  port.postMessage(message);
};

export const askSidePanelStoreUpdate = async (port: chrome.runtime.Port) => {
  const message: Message = {
    action: MESSAGE_UPDATE_STORE,
    target: MESSAGE_SIDEPANEL,
    sender: MESSAGE_POPUP,
  };
  port.postMessage(message);
};
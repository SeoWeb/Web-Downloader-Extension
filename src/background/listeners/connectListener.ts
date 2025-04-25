// import { sendMessage } from "../../common/chrome";
import { chromeStorage } from "../../common/chrome/storage";
import {
  Message,
  MESSAGE_BACKGROUND,
  MESSAGE_POPUP,
  MESSAGE_SEND_SOCKET_MESSAGE,
  MESSAGE_SIDEPANEL,
  MESSAGE_UPDATE_STORE,
} from "../../types/message";
import { getSocket } from "../connection";

let popupPort: chrome.runtime.Port | null = null;
let sidePanelPort: chrome.runtime.Port | null = null;

const stopDownloading = async () => {
  await chromeStorage.setPartialItem("download-status-storage", {
    isDownloading: false,
  });

  console.log("download stopped");
};

const askPopupStoreUpdate = async (port: chrome.runtime.Port) => {
  const message: Message = {
    action: MESSAGE_UPDATE_STORE,
    target: MESSAGE_POPUP,
    sender: MESSAGE_SIDEPANEL,
  };
  port.postMessage(message);
};

const askSidePanelStoreUpdate = async (port: chrome.runtime.Port) => {
  const message: Message = {
    action: MESSAGE_UPDATE_STORE,
    target: MESSAGE_SIDEPANEL,
    sender: MESSAGE_POPUP,
  };
  port.postMessage(message);
};

const sidePanelOpenListener = async (port: chrome.runtime.Port) => {
  if (port.name === MESSAGE_SIDEPANEL) {
    await askSidePanelStoreUpdate(port);
  }
};

const popupOpenListener = async (port: chrome.runtime.Port) => {
  if (port.name === MESSAGE_POPUP) {
    await askPopupStoreUpdate(port);
  }
};

const sendSocketMessage = async (message: Message) => {
  const socket = getSocket();
  if (message.data && message.data.action && message.data.data && socket) {
    socket.emit(message.data.action, message.data.data);
  }
};

const portOnMessageListener = async (
  message: Message,
  port: chrome.runtime.Port,
) => {
  if (port.name === message.sender) {
    if (message.target === MESSAGE_BACKGROUND) {
      switch (message.action) {
        case MESSAGE_SEND_SOCKET_MESSAGE:
          await sendSocketMessage(message);
      }
    } else if (message.target === MESSAGE_POPUP && popupPort) {
      popupPort.postMessage(message);
    } else if (message.target === MESSAGE_SIDEPANEL && sidePanelPort) {
      sidePanelPort.postMessage(message);
    }
  }
};

const portOnDisconnectListener = async (port: chrome.runtime.Port) => {
  if (port.name === MESSAGE_POPUP) {
    popupPort = null;
  } else if (port.name === MESSAGE_SIDEPANEL) {
    await stopDownloading();
    sidePanelPort = null;
  }
  console.log(`Port '${port.name}' disconnected.`);
};

export const connectListener = async (port: chrome.runtime.Port) => {
  console.log("Port connected:", port.name);

  if (port.name === MESSAGE_POPUP) {
    popupPort = port;
  } else if (port.name === MESSAGE_SIDEPANEL) {
    sidePanelPort = port;
  }

  await sidePanelOpenListener(port);
  await popupOpenListener(port);

  port.onMessage.addListener(portOnMessageListener);
  port.onDisconnect.addListener(portOnDisconnectListener);
};

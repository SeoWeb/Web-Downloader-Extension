import {
  Message,
  MESSAGE_BACKGROUND,
  MESSAGE_POPUP,
  MESSAGE_SEND_SOCKET_MESSAGE,
  MESSAGE_SIDEPANEL,
} from "../../types/message";
import { getSocket } from "../connection";
import {
  getPopupPort,
  getSidePanelPort,
  pushPopupMessageQueue,
  pushSidePanelMessageQueue,
} from "./portManager";

const sendSocketMessage = async (message: Message) => {
  const socket = getSocket();
  if (message.data && message.data.action && message.data.data && socket) {
    socket.emit(message.data.action, message.data.data);
  }
};

export const portOnMessageListener = async (
  message: Message,
  port: chrome.runtime.Port,
) => {
  if (port.name === message.sender) {
    if (message.target === MESSAGE_BACKGROUND) {
      switch (message.action) {
        case MESSAGE_SEND_SOCKET_MESSAGE:
          await sendSocketMessage(message);
          break; // Added break statement
        // Add other background actions here if needed
      }
    } else if (message.target === MESSAGE_POPUP) {
      const popupPort = getPopupPort();
      if (popupPort) {
        popupPort.postMessage(message);
      } else {
        pushPopupMessageQueue(message);
      }
    } else if (message.target === MESSAGE_SIDEPANEL) {
      const sidePanelPort = getSidePanelPort();
      if (sidePanelPort) {
        sidePanelPort.postMessage(message);
      } else {
        pushSidePanelMessageQueue(message);
      }
    }
  }
};
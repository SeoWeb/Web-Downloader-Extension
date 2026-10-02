import { Message, MESSAGE_POPUP } from "../../../types/message";
import { getPopupPort, pushPopupMessageQueue } from "../portManager";

export const listenPopupMessages = async (
  message: Message,
  _port: chrome.runtime.Port,
) => {
  if (message.target === MESSAGE_POPUP) {
    const popupPort = getPopupPort();
    if (popupPort) {
      popupPort.postMessage(message);
    } else {
      pushPopupMessageQueue(message);
    }
  }
};

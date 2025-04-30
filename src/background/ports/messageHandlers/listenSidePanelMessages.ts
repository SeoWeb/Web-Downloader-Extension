import { Message, MESSAGE_SIDEPANEL } from "../../../types/message";
import { getSidePanelPort, pushSidePanelMessageQueue } from "../portManager";

export const listenSidePanelMessages = async (message: Message, _port: chrome.runtime.Port) => {
  if (message.target === MESSAGE_SIDEPANEL) {
    const sidePanelPort = getSidePanelPort();
    if (sidePanelPort) {
      sidePanelPort.postMessage(message);
    } else {
      pushSidePanelMessageQueue(message);
    }
  }
}
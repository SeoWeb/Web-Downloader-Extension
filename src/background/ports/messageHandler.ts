import { Message } from "../../types/message";
import { listenBackgroundMessages } from "./messageHandlers/listenBackgroundMessages";
import { listenPopupMessages } from "./messageHandlers/listenPopupMessages";
import { listenSidePanelMessages } from "./messageHandlers/listenSidePanelMessages";

export const portOnMessageListener = async (
  message: Message,
  port: chrome.runtime.Port,
) => {
  if (port.name === message.sender) {
    await listenBackgroundMessages(message, port);
    await listenPopupMessages(message, port);
    await listenSidePanelMessages(message, port);
  }
};

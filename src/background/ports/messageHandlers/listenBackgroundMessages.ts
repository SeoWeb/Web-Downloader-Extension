import { Message, MESSAGE_BACKGROUND } from "../../../types/message";
import { scrollPageDownAction } from "./scrollPageDownAction";
import { sendSocketMessageAction } from "./sendSocketMessageAction";

export const listenBackgroundMessages = async (message: Message, port: chrome.runtime.Port) => {
  if (message.target === MESSAGE_BACKGROUND) {
    await scrollPageDownAction(message, port);
    await sendSocketMessageAction(message, port);
  }
};
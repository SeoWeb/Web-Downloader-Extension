import { Message, MESSAGE_BACKGROUND } from "../../../types/message";
import { scrollPageDownAction } from "./scrollPageDownAction";
import { sendSocketMessageAction } from "./sendSocketMessageAction";
import { downloadAssetsAction } from "./downloadAssetsAction";
import { simulateDownloadDoneAction } from "./simulateDownloadDoneAction";

export const listenBackgroundMessages = async (
  message: Message,
  port: chrome.runtime.Port,
) => {
  if (message.target === MESSAGE_BACKGROUND) {
    // Specific actions
    await scrollPageDownAction(message, port);
    await sendSocketMessageAction(message, port);
    await downloadAssetsAction(message, port);
    await simulateDownloadDoneAction(message, port); // Added new action
  }
};

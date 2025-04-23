import { openOptions } from "./messageActions/openOptions";
import { openSidePanel } from "./messageActions/openSidePanel";
import { Message, ResponseMessage } from "./types";

export async function sendMessage(message: Message) {
  return await chrome.runtime.sendMessage(message);
}

export const messageListener = (
  message: Message,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: ResponseMessage) => void,
) => {
  if (sender?.id !== chrome.runtime.id) {
    return;
  }

  switch (message.action) {
    case "openOptions":
      openOptions(sendResponse);
      break;
    case "openSidePanel":
      openSidePanel(message.data?.tab, sendResponse);
      break;
  }
};

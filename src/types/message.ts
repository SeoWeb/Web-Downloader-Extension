export type MessageAction =
  | "updateStore"
  | "sendSocketMessage"
  | "startDownload"
  | "scrollPageDown"
  | "doneScrollingDown";
export type MessageTarget = "background" | "sidepanel" | "popup";
export type MessageSender = "background" | "sidepanel" | "popup";

export const MESSAGE_UPDATE_STORE: MessageAction = "updateStore";
export const MESSAGE_SEND_SOCKET_MESSAGE: MessageAction = "sendSocketMessage";
export const MESSAGE_START_DOWNLOAD: MessageAction = "startDownload";
export const MESSAGE_SCROLL_PAGE_DOWN: MessageAction = "scrollPageDown";
export const MESSAGE_DONE_SCROLLING_DOWN: MessageAction = 'doneScrollingDown';

export const MESSAGE_BACKGROUND: MessageSender = "background";
export const MESSAGE_SIDEPANEL: MessageSender = "sidepanel";
export const MESSAGE_POPUP: MessageSender = "popup";

export interface Message {
  action: MessageAction;
  target: MessageTarget;
  sender: MessageSender;
  data?: any;
}

export interface ResponseMessage {
  success: boolean;
  message: string;
}

export type MessageListener = (
  message: Message,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: ResponseMessage) => void,
) => void;

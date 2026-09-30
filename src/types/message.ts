export type MessageAction =
  | "updateStore"
  | "sendSocketMessage"
  | "startDownload"
  | "scrollPageDown"
  | "doneScrollingDown"
  | "downloadDone"
  | "downloadAssets"
  | "simulateDownloadDone";
export type MessageTarget = "background" | "sidepanel" | "popup";
export type MessageSender = "background" | "sidepanel" | "popup";

export const MESSAGE_UPDATE_STORE: MessageAction = "updateStore";
export const MESSAGE_SEND_SOCKET_MESSAGE: MessageAction = "sendSocketMessage";
export const MESSAGE_START_DOWNLOAD: MessageAction = "startDownload";
export const MESSAGE_SCROLL_PAGE_DOWN: MessageAction = "scrollPageDown";
export const MESSAGE_DONE_SCROLLING_DOWN: MessageAction = 'doneScrollingDown';
export const MESSAGE_DOWNLOAD_DONE: MessageAction = "downloadDone";
export const MESSAGE_DOWNLOAD_ASSETS: MessageAction = "downloadAssets";
export const MESSAGE_SIMULATE_DOWNLOAD_DONE: MessageAction = "simulateDownloadDone";

export const MESSAGE_BACKGROUND: MessageSender = "background";
export const MESSAGE_SIDEPANEL: MessageSender = "sidepanel";
export const MESSAGE_POPUP: MessageSender = "popup";

export type MessageDataAction =
  | "addHtmlChunk"
  | "htmlChunksDone"
  | "submitHtml"
  | "htmlDone";

export interface MessageData {
  action: MessageDataAction;
  data?: any;
}

export interface AssetData {
  [groupName: string]: string[]; // e.g., { "images": ["url1", "url2"], "fonts": ["url3"] }
}

export interface Message {
  action: MessageAction;
  target: MessageTarget;
  sender: MessageSender;
  data?: any; // Keep for existing actions
  assets?: AssetData; // For downloadDone
  assetUrls?: string[]; // For downloadAssets
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

export interface SocketResponse {
  success: boolean;
  message?: string;
  data?: any;
}
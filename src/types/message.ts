export type MessageAction = "openOptions" | "updateStore" | "submitSampleHtml";
export type MessageTarget = "background" | "sidepanel" | "popup";

export interface Message {
  action: MessageAction;
  target: MessageTarget;
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

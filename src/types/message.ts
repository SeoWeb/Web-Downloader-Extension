export type MessageAction = "openOptions" | "openSidePanel";
export type MessageTarget = "backend" | "sidepanel" | "popup";

export interface Message {
  action: MessageAction;
  target: MessageTarget;
  data: any;
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

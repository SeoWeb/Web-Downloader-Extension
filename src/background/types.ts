export type MessageAction = "openOptions" | "openSidePanel";

export interface Message {
  action: MessageAction;
  data: any;
}

export interface ResponseMessage {
  success: boolean;
  message: string;
}
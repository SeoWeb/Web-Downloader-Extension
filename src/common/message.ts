export type MessageAction = "PANEL_MESSAGE" | "START_SCROLL" | "DOWNLOAD_DONE";

export const messageActions: Record<MessageAction, MessageAction> = {
  PANEL_MESSAGE: "PANEL_MESSAGE",
  START_SCROLL: "START_SCROLL",
  DOWNLOAD_DONE: "DOWNLOAD_DONE",
};

import { sendMessage } from "../common/chrome";
import { MessageAction, messageActions } from "../common/message";
console.log("MessageActions in background:", messageActions);
import { scrollDownAndScrape, startDownload } from "./jobs";

export async function sendMessageToPanel(
  action: MessageAction,
  data: any,
  force: boolean = true,
) {
  return await sendMessage(
    "side-panel",
    {
      action,
      data,
    },
    force,
  );
}

type Message = {
  action: MessageAction;
  data: any;
};

export async function messageWorker(
  action: MessageAction,
  data: any,
  addMessage: (message: Message) => void,
): Promise<any> {
  if (!messageActions) {
    console.error("messageActions is not defined!");
    throw new Error("messageActions is not defined");
  }

  switch (action) {
    case messageActions.START_SCROLL:
      return await scrollDownAndScrape(data.tabId);

    case messageActions.START_DOWNLOAD:
      return await startDownload(
        data.html,
        data.tabUrl,
        data.downloadOptions,
        (message: string) =>
          addMessage({
            action: messageActions.PANEL_MESSAGE,
            data: { message },
          }),
      );

    case messageActions.CHECK_ONLINE_STATUS:
      return true;

    default:
      return null;
  }
}

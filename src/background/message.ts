import { sendMessage } from "../common/chrome";
import { MessageAction, messageActions } from "../common/message";
import { scrollDownAndScrape } from "./jobs";

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

export async function messageWorker(
  action: MessageAction,
  data: any,
): Promise<any> {
  switch (action) {
    case messageActions.START_SCROLL:
      return await scrollDownAndScrape(data.tabId);

    default:
      return null;
  }
}

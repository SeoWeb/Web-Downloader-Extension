import { sendMessage } from "../common/chrome";
import { MessageAction } from "../common/message";

export async function sendMessageToBackground(
  action: MessageAction,
  data: any,
  force: boolean = true,
) {
  return await sendMessage(
    "background",
    {
      action,
      data,
    },
    force,
  );
}

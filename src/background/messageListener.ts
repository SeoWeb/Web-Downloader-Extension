import { openOptions } from "./messageActions/openOptions";
import { openSidePanel } from "./messageActions/openSidePanel";
import { Message, MessageTarget, ResponseMessage } from "../types/message";
import { listenMessage } from "../common/chrome";

const callback = async (message: Message): Promise<ResponseMessage> => {
  switch (message.action) {
    case "openOptions": return await openOptions();
    case "openSidePanel": return await openSidePanel(message.data?.tab);
  }
}

export const messageListener = async (target: MessageTarget) => {
  listenMessage(callback, target);
}

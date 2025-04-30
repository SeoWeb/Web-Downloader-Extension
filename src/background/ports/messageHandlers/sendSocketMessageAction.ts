import { Message, MESSAGE_SEND_SOCKET_MESSAGE } from "../../../types/message";
import { sendSocketMessage } from "./sendSocketMessage";

export const sendSocketMessageAction = async (message: Message, _port: chrome.runtime.Port) => {
  if (message.action === MESSAGE_SEND_SOCKET_MESSAGE) {
    const response = await sendSocketMessage(message);
    if (!response.success) {
      console.warn(response.message || 'unsuccessful message');
    }
  }
}
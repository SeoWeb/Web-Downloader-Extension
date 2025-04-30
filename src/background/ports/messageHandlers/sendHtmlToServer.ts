import {
  Message,
  MESSAGE_BACKGROUND,
  MESSAGE_SEND_SOCKET_MESSAGE,
  SocketResponse,
} from "../../../types/message";
import { sendSocketMessage, } from "./sendSocketMessage";

type SendHtmlToServer = (html: string) => Promise<SocketResponse>;

export const sendHtmlToServer: SendHtmlToServer = async (html) => {
  const chunkSize: number = 1000;
  const message: Message = {
    action: MESSAGE_SEND_SOCKET_MESSAGE,
    target: MESSAGE_BACKGROUND,
    sender: MESSAGE_BACKGROUND,
    data: {
      action: 'submitHtml',
      data: null
    },
  };
  for (let i = 0; i < html.length; i += chunkSize) {
    message.data.data = html.substring(i, i + chunkSize);
    const response = await sendSocketMessage(message);
    if (!response.success) {
      return response;
    }
  }
  message.data.data = {
    success: true
  };
  return await sendSocketMessage(message);
}
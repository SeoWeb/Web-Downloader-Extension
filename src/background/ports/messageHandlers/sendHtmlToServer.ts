import {
  Message,
  MESSAGE_BACKGROUND,
  MESSAGE_SEND_SOCKET_MESSAGE,
  MessageDataAction,
  SocketResponse,
} from "../../../types/message";
import { sendSocketMessage } from "./sendSocketMessage";

type SendHtmlToServer = (html: string) => Promise<SocketResponse>;

function buildMessage(action: MessageDataAction, data: any): Message {
  const message: Message = {
    action: MESSAGE_SEND_SOCKET_MESSAGE,
    target: MESSAGE_BACKGROUND,
    sender: MESSAGE_BACKGROUND,
    data: {
      action,
      data,
    },
  };
  return message;
}

async function sentHtmlChunk(
  html: string,
  i: number,
  chunkSize: number = 1000,
): Promise<SocketResponse> {
  const message = buildMessage(
    "addHtmlChunk",
    html.substring(i, i + chunkSize),
  );
  return await sendSocketMessage(message);
}

async function sendHtmlChunksDone(): Promise<SocketResponse> {
  const message = buildMessage("htmlChunksDone", "done");
  return await sendSocketMessage(message);
}

export const sendHtmlToServer: SendHtmlToServer = async (html) => {
  const chunkSize: number = 1000;
  for (let i = 0; i < html.length; i += chunkSize) {
    const response = await sentHtmlChunk(html, i, chunkSize);
    if (!response.success) {
      console.error("Error sending HTML chunk:", response.message);
      return response;
    }
  }
  return await sendHtmlChunksDone();
};

export const sendHtmlDoneMessage = async (): Promise<SocketResponse> => {
  const message = buildMessage("htmlDone", "done");
  return await sendSocketMessage(message);
};

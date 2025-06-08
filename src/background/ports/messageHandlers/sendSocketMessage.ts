import { Message, SocketResponse } from "../../../types/message";
import { getSocket } from "../../connection";

export const sendSocketMessage = async (message: Message): Promise<SocketResponse> => {
  const socket = await getSocket();

  if (!socket) {
    return {
      success: false,
      message: 'No socket'
    }
  }

  if (message.data && message.data.action && message.data.data) {
    return new Promise<SocketResponse>((resolve) => {
      if (message.data && message.data.action && message.data.data) {
        socket.emit(message.data.action, message.data.data, (response: SocketResponse) => {
          resolve(response)
        });
      } else {
        resolve({
          success: false,
          message: 'Invalid message data'
        });
      }
    })
  }

  console.log('message', message);

  return {
    success: false,
    message: 'problems with message'
  }
};
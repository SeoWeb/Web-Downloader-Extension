import { openOptions } from "../messageActions/openOptions";
import { Message, MessageTarget, ResponseMessage } from "../../types/message";
import { listenMessage } from "../../common/chrome";
import { getSocket } from "../connection";

const callback = async (message: Message): Promise<ResponseMessage> => {
  switch (message.action) {
    case "openOptions": return await openOptions();
    case "submitSampleHtml": // Added case
      const htmlContent = message.data?.htmlContent;
      console.log('html', htmlContent);
      const socket = getSocket();
      if (typeof htmlContent === 'string' && socket) { // Check if htmlContent is a string and socket exists
        socket.emit('submitHtml', htmlContent); // Send HTML via socket
        console.log('message sent!');
        return { success: true, message: "HTML submitted via socket." };
      } else {
        return { success: false, message: "Invalid HTML content or socket not available." };
      }
    default: // Added default case
      console.warn(`Unhandled message action: ${message.action}`);
      return { success: false, message: `Unknown action: ${message.action}` };
  }
}

export const messageListener = async (target: MessageTarget) => {
  listenMessage(callback, target);
}

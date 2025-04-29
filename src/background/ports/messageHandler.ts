import {
  Message,
  MESSAGE_BACKGROUND,
  MESSAGE_DONE_SCROLLING_DOWN,
  MESSAGE_POPUP,
  MESSAGE_SCROLL_PAGE_DOWN,
  MESSAGE_SEND_SOCKET_MESSAGE,
  MESSAGE_SIDEPANEL,
} from "../../types/message";
import { getSocket } from "../connection";
import { scrollPageDown } from "./actions/scrollPageDown";
import {
  getPopupPort,
  getSidePanelPort,
  pushPopupMessageQueue,
  pushSidePanelMessageQueue,
} from "./portManager";

const sendSocketMessage = async (message: Message) => {
  const socket = getSocket();
  if (message.data && message.data.action && message.data.data && socket) {
    return new Promise((resolve) => {
      socket.emit(message.data.action, message.data.data, () => {
        resolve(true)
      });
    })
  }
};

const sendHtmlToServer: (html: string) => Promise<void> = async (html) => {
  const chunkSize: number = 1000;
  for (let i = 0; i < html.length; i += chunkSize) {
    const chunk = html.substring(i, i + chunkSize);
    console.log(chunk);
    const message: Message = {
      action: MESSAGE_SEND_SOCKET_MESSAGE,
      target: MESSAGE_BACKGROUND,
      sender: MESSAGE_BACKGROUND,
      data: {
        action: 'submitHtml',
        data: chunk
      },
    };
    await sendSocketMessage(message);

    // await new Promise((resolve) => {
    //   setTimeout(() => {
    //     resolve(true);
    //   }, 10);
    // })
  }
  const message: Message = {
    action: MESSAGE_SEND_SOCKET_MESSAGE,
    target: MESSAGE_BACKGROUND,
    sender: MESSAGE_BACKGROUND,
    data: {
      action: 'submitHtml',
      data: {
        success: true
      }
    },
  };
  await sendSocketMessage(message);
}

export const portOnMessageListener = async (
  message: Message,
  port: chrome.runtime.Port,
) => {
  if (port.name === message.sender) {
    if (message.target === MESSAGE_BACKGROUND) {
      switch (message.action) {
        case MESSAGE_SCROLL_PAGE_DOWN:
          await scrollPageDown(sendHtmlToServer);
          port.postMessage({
            action: MESSAGE_DONE_SCROLLING_DOWN,
            target: MESSAGE_SIDEPANEL,
            sender: MESSAGE_BACKGROUND
          });
          break;
        case MESSAGE_SEND_SOCKET_MESSAGE:
          await sendSocketMessage(message);
          break;
      }
    } else if (message.target === MESSAGE_POPUP) {
      const popupPort = getPopupPort();
      if (popupPort) {
        popupPort.postMessage(message);
      } else {
        pushPopupMessageQueue(message);
      }
    } else if (message.target === MESSAGE_SIDEPANEL) {
      const sidePanelPort = getSidePanelPort();
      if (sidePanelPort) {
        sidePanelPort.postMessage(message);
      } else {
        pushSidePanelMessageQueue(message);
      }
    }
  }
};
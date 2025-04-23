import { Message, MessageListener, MessageTarget, ResponseMessage } from "../../types/message";

export function listenMessage(
  callback: (message: Message) => Promise<ResponseMessage>,
  target: MessageTarget,
): () => void {
  const listener: MessageListener = (message, sender, sendResponse) => {
    if (
      message.target === target &&
      sender?.id &&
      sender.id === chrome.runtime.id
    ) {
      callback(message).then(sendResponse);
    }

    return true;
  };

  chrome.runtime.onMessage.addListener(listener);

  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}

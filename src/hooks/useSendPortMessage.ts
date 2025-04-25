import { useConnectPortStore } from "../store/useConnectPortStore";
import { MESSAGE_BACKGROUND, MessageAction, MessageSender, MessageTarget } from "../types/message";

export default function useSendPortMessage(sender: MessageSender) {
  const { port } = useConnectPortStore();

  const sendPortMessage = async (action: MessageAction, target: MessageTarget = MESSAGE_BACKGROUND) => {
    if (port) {
      port.postMessage({
        action,
        target,
        sender
      });
    }
  };

  return {
    sendPortMessage,
  };
}

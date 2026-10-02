import { useConnectPortStore } from "../store/useConnectPortStore";
import {
  MESSAGE_BACKGROUND,
  MessageAction,
  MessageSender,
  MessageTarget,
} from "../types/message";

export default function useSendPortMessage(sender: MessageSender) {
  const { port } = useConnectPortStore();

  const sendPortMessage = async (
    action: MessageAction,
    payload?: Record<string, any>,
    target: MessageTarget = MESSAGE_BACKGROUND,
  ) => {
    if (port) {
      port.postMessage({
        action,
        target,
        sender,
        ...(payload && payload), // Spread payload if it exists
      });
    }
  };

  return {
    sendPortMessage,
  };
}

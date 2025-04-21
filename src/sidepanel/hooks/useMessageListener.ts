import { useEffect } from "react";
import { listenMessage } from "../../common/chrome";
import { MessageAction } from "../../common/message";

interface UseMessageListenerProps {
  messageWorker: (action: MessageAction, data: any) => Promise<any>;
}

export function useMessageListener({ messageWorker }: UseMessageListenerProps) {
  useEffect(() => {
    const callbackFn = listenMessage(async (message, _addMessage) => {
      const action = message.action;
      const data = message.data;
      return messageWorker(action, data);
    }, "side-panel");

    // Cleanup function to remove the listener when the component unmounts
    return () => {
      callbackFn();
    };
  }, [messageWorker]); // Include messageWorker in the dependency array
}
import { useEffect } from "react";
import { Message, ResponseMessage } from "../types/message";
import { listenMessage } from "../common/chrome/listenMessage";

const callback = async (message: Message): Promise<ResponseMessage> => {
  switch (message.action) {
    // case "openOptions": return await openOptions();
    // case "openSidePanel": return await openSidePanel(message.data?.tab);
  }

  return {
    success: false,
    message: ""
  }
}

export function useMessageListener() {
  useEffect(() => {
    const callbackFn = listenMessage(callback, "sidepanel");

    return () => {
      callbackFn();
    };
  }, []);
}
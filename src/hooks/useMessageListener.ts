import { useEffect } from "react";
import { Message, MessageTarget, ResponseMessage } from "../types/message";
import { listenMessage } from "../common/chrome/listenMessage";
import { useDownloadSettingsStore } from '../store/downloadSettingsStore';
import { useDownloadStatusStore } from '../store/downloadStatusStore';

const updateStore = async (): Promise<ResponseMessage> => {
  useDownloadSettingsStore.persist.rehydrate();
  useDownloadStatusStore.persist.rehydrate();

  return {
    success: true,
    message: 'ok'
  }
}

const callback = async (message: Message): Promise<ResponseMessage> => {
  switch (message.action) {
    case "updateStore": return await updateStore();
  }

  return {
    success: false,
    message: ""
  }
}

export function useMessageListener(target: MessageTarget) {
  useEffect(() => {
    const callbackFn = listenMessage(callback, target);

    return () => {
      callbackFn();
    };
  }, [target]);
}
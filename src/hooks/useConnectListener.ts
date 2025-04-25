import { useEffect } from "react";
import { Message, MESSAGE_START_DOWNLOAD, MESSAGE_UPDATE_STORE, MessageSender, MessageTarget } from "../types/message";
import { useDownloadSettingsStore } from '../store/downloadSettingsStore';
import { useDownloadStatusStore } from '../store/downloadStatusStore';
import { useConnectPortStore } from "../store/useConnectPortStore";

const updateStore = async (target: MessageTarget, port: chrome.runtime.Port): Promise<void> => {
  useDownloadSettingsStore.persist.rehydrate();
  useDownloadStatusStore.persist.rehydrate();

  port.postMessage({
    action: 'storeUpdated',
    target
  });
  console.log('port message sent from:', target);
  return ;
}

export function useConnectListener(sender: MessageSender) {
  const { port, setPort } = useConnectPortStore();
  const { setIsDownloading } = useDownloadStatusStore();

  useEffect(() => {
    setPort(chrome.runtime.connect({ name: sender }));
  }, [sender]);

  useEffect(() => {
    const callback = async (message: Message, port: chrome.runtime.Port): Promise<void> => {
      switch (message.action) {
        case MESSAGE_UPDATE_STORE: return await updateStore(message.target, port);
        case MESSAGE_START_DOWNLOAD:
          setIsDownloading(true);
          break;
      }
    
      return ;
    }

    console.log('ucl', sender, port?.name);

    if (port) {
      port.onMessage.addListener(callback);
    }

    return () => {
      if (port) {
        port.onMessage.removeListener(callback);
        port.disconnect();
      }
    }
  }, [port]);

  return {
    port
  }
}
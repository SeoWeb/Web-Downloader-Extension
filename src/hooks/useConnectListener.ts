import { useEffect } from "react";
import {
  Message,
  MESSAGE_DONE_SCROLLING_DOWN,
  MESSAGE_START_DOWNLOAD,
  MESSAGE_UPDATE_STORE,
  MessageSender,
  MessageTarget,
} from "../types/message";
import { useDownloadSettingsStore } from "../store/downloadSettingsStore";
import { useDownloadStatusStore } from "../store/downloadStatusStore";
import { useConnectPortStore } from "../store/useConnectPortStore";

const updateStore = async (
  target: MessageTarget,
  port: chrome.runtime.Port,
): Promise<void> => {
  useDownloadSettingsStore.persist.rehydrate();
  useDownloadStatusStore.persist.rehydrate();

  port.postMessage({
    action: "storeUpdated",
    target,
  });
  return;
};

export function useConnectListener(
  sender: MessageSender,
  listener?: (message: Message, port: chrome.runtime.Port) => void,
) {
  const { port, setPort } = useConnectPortStore();
  const { setIsDownloading } = useDownloadStatusStore();

  useEffect(() => {
    const newPort = chrome.runtime.connect({ name: sender });
    setPort(newPort);
    // Optional: Clean up the port on component unmount, though store might handle it
    return () => {
      if (newPort) {
        try {
          newPort.disconnect();
        } catch (error) {
          // ignore error - port already disconnected
        }
      }
      setPort(null); // Clear port from store on disconnect
    };
  }, [sender, setPort]);

  useEffect(() => {
    const internalCallback = async (
      message: Message,
      p: chrome.runtime.Port, // Renamed to avoid conflict with 'port' from outer scope
    ): Promise<void> => {
      // Internal handling
      switch (message.action) {
        case MESSAGE_UPDATE_STORE:
          await updateStore(message.target, p);
          break;
        case MESSAGE_START_DOWNLOAD:
          setIsDownloading(true);
          break;
        case MESSAGE_DONE_SCROLLING_DOWN:
          // TODO: start downloading assets or rename action
          setIsDownloading(false);
          break;
      }

      // Call the external listener if provided
      if (listener) {
        listener(message, p);
      }
    };

    if (port) {
      port.onMessage.addListener(internalCallback);
    }

    return () => {
      if (port) {
        try {
          port.onMessage.removeListener(internalCallback);
        } catch (error) {
          // ignore error
        }
      }
    };
  }, [port, listener, setIsDownloading]); // Added listener and setIsDownloading to dependency array

  return {
    port, // Still returning port, though direct use might be less common now
  };
}

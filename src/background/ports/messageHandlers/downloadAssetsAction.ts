import { Message, MESSAGE_DOWNLOAD_ASSETS } from "../../../types/message";

export const downloadAssetsAction = async (message: Message, port: chrome.runtime.Port): Promise<void> => {
  if (message.action === MESSAGE_DOWNLOAD_ASSETS && message.assetUrls) {
    console.log(`Background: Received ${MESSAGE_DOWNLOAD_ASSETS} from ${port.name} with URLs:`, message.assetUrls);
    // In a real scenario, you would trigger download logic here.
    // For now, we just log.
    // Example: port.postMessage({ action: "downloadProgress", data: "starting downloads..." });
  }
};

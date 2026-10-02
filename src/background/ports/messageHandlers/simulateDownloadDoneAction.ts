import {
  Message,
  MESSAGE_SIMULATE_DOWNLOAD_DONE,
  MESSAGE_DOWNLOAD_DONE,
  MESSAGE_SIDEPANEL,
  MESSAGE_BACKGROUND,
  AssetData,
} from "../../../types/message";
import { getSidePanelPort, pushSidePanelMessageQueue } from "../portManager";

export const simulateDownloadDoneAction = async (
  message: Message,
  port: chrome.runtime.Port,
): Promise<void> => {
  if (message.action === MESSAGE_SIMULATE_DOWNLOAD_DONE) {
    console.log(
      `Background: Received ${MESSAGE_SIMULATE_DOWNLOAD_DONE} from ${port.name}. Simulating download done event.`,
    );

    const mockAssets: AssetData = {
      images: [
        "http://example.com/img1.png",
        "http://example.com/img2.jpg",
        "https://picsum.photos/200/300",
      ],
      fonts: [
        "http://example.com/font.woff",
        "https://example.com/anotherfont.ttf",
      ],
      scripts: ["http://example.com/main.js"],
      styles: [
        "http://example.com/theme.css",
        "http://example.com/another.css",
      ],
    };

    const messageToSidepanel: Message = {
      action: MESSAGE_DOWNLOAD_DONE,
      target: MESSAGE_SIDEPANEL,
      sender: MESSAGE_BACKGROUND,
      assets: mockAssets,
    };

    const sidePanelPort = getSidePanelPort();
    if (sidePanelPort) {
      try {
        sidePanelPort.postMessage(messageToSidepanel);
        console.log(
          `Background: Sent ${MESSAGE_DOWNLOAD_DONE} to sidepanel via direct port.`,
        );
      } catch (error) {
        console.error(
          `Background: Error posting message to sidePanelPort: ${error}. It might have been disconnected. Queuing message.`,
        );
        // Fallback to queue if postMessage fails (e.g., port disconnected during the try)
        pushSidePanelMessageQueue(messageToSidepanel);
        console.log(
          `Background: Queued ${MESSAGE_DOWNLOAD_DONE} for sidepanel.`,
        );
      }
    } else {
      pushSidePanelMessageQueue(messageToSidepanel);
      console.log(
        `Background: Queued ${MESSAGE_DOWNLOAD_DONE} for sidepanel as port was not available.`,
      );
    }
  }
};

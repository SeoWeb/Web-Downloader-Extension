import { scrollLoop } from "../../../client/functions/scrollUtils";
import { chromeStorage } from "../../../common/chrome/storage";
import {
  Message,
  MESSAGE_BACKGROUND,
  MESSAGE_DONE_SCROLLING_DOWN,
  MESSAGE_SCROLL_PAGE_DOWN,
  MESSAGE_SIDEPANEL,
} from "../../../types/message";
import { closeSocketConnection } from "../../connection";

async function getActiveTab() {
  const tabId = await chromeStorage.getItemValue(
    "download-settings-storage",
    "activeTabId",
  );
  if (tabId) {
    return {
      id: parseInt(tabId),
    } as Partial<chrome.tabs.Tab>;
  }
  return null;
}

export const scrollPageDownAction = async (
  message: Message,
  port: chrome.runtime.Port,
) => {
  if (message.action === MESSAGE_SCROLL_PAGE_DOWN) {
    const tab = await getActiveTab();
    if (tab?.id) {
      await scrollLoop(tab);
    } else {
      console.log("tab not found");
    }

    // TODO: more steps are comming do not close connection yet
    await closeSocketConnection();

    port.postMessage({
      action: MESSAGE_DONE_SCROLLING_DOWN,
      target: MESSAGE_SIDEPANEL,
      sender: MESSAGE_BACKGROUND,
    });
  }
};

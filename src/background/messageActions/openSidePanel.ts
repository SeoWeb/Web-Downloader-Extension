import { ResponseMessage } from "../types";

export async function openSidePanel(
  tab: chrome.tabs.Tab | undefined,
  sendResponse: (response?: ResponseMessage) => void,
) {
  if (tab?.id) {
    const tabId: number = tab.id;
    chrome.sidePanel.setOptions(
      {
        tabId,
        path: "sidePanel.html",
        enabled: true,
      },
      () => {
        chrome.sidePanel.open({ tabId });
        sendResponse({
          success: true,
          message: "done",
        });
      },
    );
  } else {
    sendResponse({
      success: false,
      message: "tab not found",
    });
  }
}

import { ResponseMessage } from "../../types/message";

export async function openSidePanel(
  tab: chrome.tabs.Tab | undefined,
): Promise<ResponseMessage> {
  if (tab?.id) {
    const tabId: number = tab.id;
    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidePanel.html",
      enabled: true,
    });
    chrome.sidePanel.open({ tabId });
    return {
      success: true,
      message: "done",
    };
  }

  return {
    success: false,
    message: "tab not found",
  };
}

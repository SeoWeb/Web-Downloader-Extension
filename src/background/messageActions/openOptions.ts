import { ResponseMessage } from "../types";

export async function openOptions(sendResponse: (response?: ResponseMessage) => void) {
  await chrome.runtime.openOptionsPage();
  sendResponse({
    success: true,
    message: "done",
  });
}
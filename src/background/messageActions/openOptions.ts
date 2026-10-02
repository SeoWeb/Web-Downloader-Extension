import { ResponseMessage } from "../../types/message";

export async function openOptions(): Promise<ResponseMessage> {
  await chrome.runtime.openOptionsPage();
  return {
    success: true,
    message: "done",
  };
}

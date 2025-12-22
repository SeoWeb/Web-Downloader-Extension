import { smoothScrollToBottom } from "../client/fn";
import { executeScript } from "../common/chrome";
import { downloadResources } from "./download";

export async function scrollDownAndScrape(tabId: number) {
  const scrollResponse = await executeScript(tabId, smoothScrollToBottom);
  if (scrollResponse.success) {
    const top = scrollResponse.top;
    const html = scrollResponse.html;
    const height = scrollResponse.height;
    return {
      top,
      html,
      height,
      viewportHeight: scrollResponse.viewportHeight,
    };
  }

  return null;
}

export async function startDownload(
  html: string,
  tabUrl: string,
  downloadOptions: any,
  addMessage: (message: string) => void,
) {
  return await downloadResources(html, tabUrl, downloadOptions, addMessage);
}

import { smoothScrollToBottom } from "../client/fn";
import { executeScript } from "../common/chrome";

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
    };
  }

  return null;
}

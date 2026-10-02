import { chromeStorage } from "../../common/chrome/storage";
import {
  smoothScrollToBottom,
  Response as SmoothScrollResponse,
} from "./smoothScrollToBottom"; // Adjusted path
import { executeScript } from "../../common/chrome/executeScript"; // Adjusted path
import { sendHtmlToServer } from "../../background/ports/messageHandlers/sendHtmlToServer";

export async function isDownloading(): Promise<boolean> {
  try {
    return (
      (await chromeStorage.getItemValue(
        "download-status-storage",
        "isDownloading",
      )) ?? false
    );
  } catch (error) {
    console.error(
      "[scrollToBottomAction] Error checking download status:", // Keep original log prefix for now? Or update? Let's update.
      error,
    );
    return false; // Assume not downloading if storage fails
  }
}

interface ScrollResult {
  scrollTop: number;
  scrollHeight: number;
  html: string;
}

export async function executeAndProcessScrollScript(
  tab: Partial<chrome.tabs.Tab>,
): Promise<ScrollResult | null> {
  try {
    const results = await executeScript<[], Promise<SmoothScrollResponse>>({
      tab,
      func: smoothScrollToBottom,
    });

    // Check if results exist and contain a valid result object
    if (!results || results.length === 0 || !results[0]?.result) {
      console.warn(
        "[scrollUtils] Scroll script did not return a valid result.", // Updated log prefix
      );
      return null;
    }
    // Ensure the result has the expected properties (basic check)
    const { scrollTop, scrollHeight, html } = results[0].result;
    if (
      typeof scrollTop !== "number" ||
      typeof scrollHeight !== "number" ||
      typeof html !== "string"
    ) {
      console.warn(
        "[scrollUtils] Scroll script returned unexpected result structure.", // Updated log prefix
      );
      return null;
    }

    return results[0].result;
  } catch (error) {
    console.error(
      "[scrollUtils] Error executing scroll script:", // Updated log prefix
      error,
    );
    return null; // Indicate failure
  }
}

export async function scrollLoop(tab: Partial<chrome.tabs.Tab>): Promise<void> {
  let lastScrollTop = -1;
  let currentScrollTop = 0;
  let currentHtml = "";
  const MAX_ITERATIONS = 500; // Safety break
  let iterations = 0;
  let is_last_scroll: boolean = false;

  const wait = async (): Promise<void> =>
    await new Promise((resolve) => setTimeout(resolve, 500));

  const isScollDone = async (): Promise<boolean> => {
    if (currentScrollTop <= lastScrollTop + 1) {
      if (!is_last_scroll) {
        await wait();
        is_last_scroll = true;
        return false;
      }

      return true;
    }

    is_last_scroll = false;
    return false;
  };

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    if (!(await isDownloading())) {
      console.log("not downloading");
      break;
    }

    const scrollResult = await executeAndProcessScrollScript(tab);
    if (!scrollResult) {
      console.log("no results");
      break;
    }

    lastScrollTop = currentScrollTop;
    currentScrollTop = scrollResult.scrollTop;
    currentHtml = scrollResult.html; // Store the latest HTML

    const socketResponse = await sendHtmlToServer(currentHtml);
    if (!socketResponse.success) {
      // TODO: clean up server
      console.log(socketResponse.message || "!success");
      break;
    }

    // Break condition: If scroll top didn't increase significantly (e.g., by more than 1 pixel)
    if (await isScollDone()) {
      break;
    }
  }
}

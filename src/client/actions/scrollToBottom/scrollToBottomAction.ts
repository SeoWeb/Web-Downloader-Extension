import { smoothScrollToBottom, Response as SmoothScrollResponse } from '../../functions/smoothScrollToBottom';
import { executeScript } from '../../../common/chrome/executeScript';
import { getActiveTab } from '../../../common/chrome/getActiveTab';
import { chromeStorage } from '../../../common/chrome/storage';

// --- Helper Functions ---

async function isDownloading(): Promise<boolean> {
  // Renamed from isDownlading to isDownloading
  try {
    return (await chromeStorage.getItemValue('download-status-storage', 'isDownloading')) ?? false;
  } catch (error) {
    console.error('[scrollToBottomAction] Error checking download status:', error);
    return false; // Assume not downloading if storage fails
  }
}

async function getActiveTabOrFail(): Promise<chrome.tabs.Tab> {
  const tab = await getActiveTab();
  if (!tab?.id) {
    console.error('[scrollToBottomAction] Could not get active tab.');
    throw new Error('Could not get active tab.');
  }
  return tab;
}

interface ScrollResult {
  scrollTop: number;
  scrollHeight: number;
  html: string;
}

async function executeAndProcessScrollScript(tab: chrome.tabs.Tab): Promise<ScrollResult | null> {
  try {
    const results = await executeScript<[], Promise<SmoothScrollResponse>>({
      tab,
      func: smoothScrollToBottom,
    });

    // Check if results exist and contain a valid result object
    if (!results || results.length === 0 || !results[0]?.result) {
      console.warn('[scrollToBottomAction] Scroll script did not return a valid result.');
      return null;
    }
    // Ensure the result has the expected properties (basic check)
    const { scrollTop, scrollHeight, html } = results[0].result;
    if (typeof scrollTop !== 'number' || typeof scrollHeight !== 'number' || typeof html !== 'string') {
        console.warn('[scrollToBottomAction] Scroll script returned unexpected result structure.');
        return null;
    }

    return results[0].result;
  } catch (error) {
    console.error('[scrollToBottomAction] Error executing scroll script:', error);
    return null; // Indicate failure
  }
}

async function scrollLoop(tab: chrome.tabs.Tab, sendHtmlToServer: (html: string) => Promise<void>): Promise<string> {
  let lastScrollTop = -1;
  let currentScrollTop = 0;
  let currentHtml = '';
  const MAX_ITERATIONS = 500; // Safety break
  let iterations = 0;

  console.log('[scrollToBottomAction] Starting scroll loop...');

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    if (!(await isDownloading())) {
      console.log('[scrollToBottomAction] Download stopped during scroll loop.');
      break;
    }

    lastScrollTop = currentScrollTop;
    console.log(`[scrollToBottomAction] Iteration ${iterations}, lastScrollTop: ${lastScrollTop}`);

    const scrollResult = await executeAndProcessScrollScript(tab);

    if (!scrollResult) {
      console.warn('[scrollToBottomAction] Stopping scroll loop due to script error or invalid result.');
      break; // Stop if script failed or returned invalid data
    }

    currentScrollTop = scrollResult.scrollTop;
    currentHtml = scrollResult.html; // Store the latest HTML

    await sendHtmlToServer(currentHtml);

    console.log(`[scrollToBottomAction] Scrolled: scrollTop=${currentScrollTop}, scrollHeight=${scrollResult.scrollHeight}`);

    // Break condition: If scroll top didn't increase significantly (e.g., by more than 1 pixel)
    if (currentScrollTop <= lastScrollTop + 1) {
      console.log('[scrollToBottomAction] Scroll position did not increase significantly. Assuming bottom reached.');
      break;
    }

    // Optional delay between scrolls if needed
    await new Promise(resolve => setTimeout(resolve, 500));
  }

   if (iterations >= MAX_ITERATIONS) {
        console.warn(`[scrollToBottomAction] Max scroll iterations (${MAX_ITERATIONS}) reached.`);
   }

  console.log('[scrollToBottomAction] Scroll loop finished.');
  return currentHtml; // Return the last successfully retrieved HTML
}

async function finalScrollCheck(tab: chrome.tabs.Tab, lastKnownHtml: string): Promise<string> {
  console.log('[scrollToBottomAction] Waiting 500ms for potential dynamic content...');
  await new Promise(resolve => setTimeout(resolve, 500));

  console.log('[scrollToBottomAction] Performing final scroll check...');
  let finalHtml = lastKnownHtml;

  try {
    const finalScrollResult = await executeAndProcessScrollScript(tab);

    if (finalScrollResult) {
      console.log('[scrollToBottomAction] Final scroll check complete.');
      finalHtml = finalScrollResult.html; // Update with the very final HTML
      console.log(`[scrollToBottomAction] Final state: scrollTop=${finalScrollResult.scrollTop}, scrollHeight=${finalScrollResult.scrollHeight}`);
    } else {
      console.warn('[scrollToBottomAction] Final scroll check failed or returned no result. Using last known HTML.');
    }
  } catch (error) {
    // This catch might be redundant if executeAndProcessScrollScript handles all its errors,
    // but kept for safety in case of unexpected issues during the call itself.
    console.error('[scrollToBottomAction] Error during final scroll check execution:', error);
    console.warn('[scrollToBottomAction] Using last known HTML due to final check error.');
  }

  return finalHtml;
}


// --- Main Action ---

/**
 * Scrolls the active tab to the bottom, handling dynamically loaded content.
 * It repeatedly executes a script to scroll down until the bottom is reached or
 * other conditions (like download stopping or max iterations) are met.
 * Includes a final check after a short delay to capture late-loading content.
 * @returns A promise that resolves with the full HTML content of the page after scrolling.
 */
export async function scrollToBottomAction(sendHtmlToServer: (html: string) => Promise<void>): Promise<string> {
  console.log('[scrollToBottomAction] Starting scroll action...');
  try {
    const tab = await getActiveTabOrFail();

    const htmlAfterLoop = await scrollLoop(tab, sendHtmlToServer);

    const finalHtml = await finalScrollCheck(tab, htmlAfterLoop);

    console.log('[scrollToBottomAction] Scroll action finished successfully.');
    return finalHtml;
  } catch (error) {
      console.error('[scrollToBottomAction] Scroll action failed:', error);
      // Depending on requirements, might re-throw, return empty string, or last known HTML if available
      throw new Error(`Scroll action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
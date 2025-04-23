import { smoothScrollToBottom, Response as SmoothScrollResponse } from '../functions/smoothScrollToBottom';
import { executeScript } from '../../common/chrome/executeScript';
import { getActiveTab } from '../../common/chrome/getActiveTab';

/**
 * Scrolls the active tab to the bottom, handling dynamically loaded content.
 * It repeatedly executes a script to scroll down in increments until the bottom is reached.
 * After reaching the bottom, it waits briefly and performs a final scroll check.
 * @returns A promise that resolves with the full HTML content of the page after scrolling.
 */
export async function scrollToBottomAction(): Promise<string> {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error('Could not get active tab.');
  }

  let lastScrollTop = -1;
  let currentScrollTop = 0;
  // let currentScrollHeight = 0; // Not strictly needed for loop logic if relying on scrollTop increase
  let currentHtml = '';
  const MAX_ITERATIONS = 50; // Safety break for max scroll attempts
  let iterations = 0;

  console.log('[scrollToBottomAction] Starting scroll...');

  do {
    iterations++;
    if (iterations > MAX_ITERATIONS) {
        console.warn(`[scrollToBottomAction] Max scroll iterations (${MAX_ITERATIONS}) reached. Stopping.`);
        break;
    }

    lastScrollTop = currentScrollTop;

    console.log(`[scrollToBottomAction] Iteration ${iterations}, lastScrollTop: ${lastScrollTop}`);

    let results: chrome.scripting.InjectionResult<SmoothScrollResponse>[] | undefined;
    try {
        results = await executeScript<[], Promise<SmoothScrollResponse>>({
          tab,
          func: smoothScrollToBottom,
        });
    } catch (error) {
        console.error('[scrollToBottomAction] Error executing scroll script:', error);
        // Depending on the desired behavior, you might want to break or re-throw
        break; // Stop scrolling on script execution error
    }


    // Check if results exist and contain a result object
    if (!results || results.length === 0 || !results[0].result) {
      console.warn('[scrollToBottomAction] Scroll script did not return a valid result. Stopping.');
      // Return last known HTML or throw error? Let's return last known HTML.
      break;
    }

    // Destructure directly from results[0].result
    const { scrollTop, scrollHeight, html } = results[0].result;
    currentScrollTop = scrollTop;
    // currentScrollHeight = scrollHeight; // Update if needed elsewhere
    currentHtml = html; // Store the latest HTML

    console.log(`[scrollToBottomAction] Scrolled: scrollTop=${currentScrollTop}, scrollHeight=${scrollHeight}`);

    // Break condition: If scroll top didn't increase significantly (e.g., by more than 1 pixel),
    // assume we've reached the bottom or are stuck.
    if (currentScrollTop <= lastScrollTop + 1) {
        console.log('[scrollToBottomAction] Scroll position did not increase significantly. Assuming bottom reached.');
        break;
    }

    // Optional: Add a small delay between scrolls if the page loads content slowly
    await new Promise(resolve => setTimeout(resolve, 100));

  } while (true); // Loop is controlled by break conditions inside

  console.log('[scrollToBottomAction] Initial scroll loop finished. Waiting 500ms for potential dynamic content...');
  await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms

  console.log('[scrollToBottomAction] Performing final scroll check...');
  let finalHtml = currentHtml; // Default to last known HTML

  try {
      const finalResults = await executeScript<[], Promise<SmoothScrollResponse>>({
        tab,
        func: smoothScrollToBottom,
      });

      if (finalResults && finalResults.length > 0 && finalResults[0].result) {
        console.log('[scrollToBottomAction] Final scroll check complete.');
        finalHtml = finalResults[0].result.html; // Update with the very final HTML
        const { scrollTop, scrollHeight } = finalResults[0].result;
        console.log(`[scrollToBottomAction] Final state: scrollTop=${scrollTop}, scrollHeight=${scrollHeight}`);
      } else {
        console.warn('[scrollToBottomAction] Final scroll check failed or returned no result. Using last known HTML.');
      }
  } catch (error) {
      console.error('[scrollToBottomAction] Error during final scroll check:', error);
      console.warn('[scrollToBottomAction] Using last known HTML due to final check error.');
  }


  console.log('[scrollToBottomAction] Scroll finished.');
  return finalHtml;
}
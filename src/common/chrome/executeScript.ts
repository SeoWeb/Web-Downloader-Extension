/**
 * Executes a function in the context of the currently active tab.
 *
 * Note: For communication *during* script execution (live updates),
 * the injected script should use `chrome.runtime.sendMessage` and
 * the extension should have a listener via `chrome.runtime.onMessage`.
 * This function primarily returns the *final* result of the script.
 *
 * @param options - Options for the script execution.
 * @param options.func - The function to execute in the tab's context. Can be async.
 * @param options.args - Optional arguments to pass to the function.
 * @returns A promise that resolves with the execution results. The result from the executed function is automatically awaited.
 * @throws If the active tab cannot be found or accessed, or if the script execution fails.
 */
export async function executeScript<Args extends unknown[], Result>(options: {
  tab: Partial<chrome.tabs.Tab>,
  func: (...args: Args) => Result; // Function can return Result or Promise<Result>
  args?: Args;
}): Promise<chrome.scripting.InjectionResult<globalThis.Awaited<Result>>[]> {

  if (!options?.tab?.id) {
    throw new Error('Could not get active tab ID.');
  }

  // Check if the scripting API is available (permission granted?)
  if (typeof chrome.scripting === 'undefined') {
    console.error('Error: chrome.scripting API is not available. Ensure the "scripting" permission is declared in manifest.json and granted by the user.');
    throw new Error('Scripting permission is required but not available.');
  }

  try {
    // Pass Args and Result directly as generic types.
    // chrome.scripting.executeScript handles awaiting the result internally.
    const results = await chrome.scripting.executeScript<Args, Result>({
      target: { tabId: options.tab.id },
      func: options.func,
      args: options.args, // Pass args directly; it's optional in the target function
      // world: 'MAIN', // Optional: Use 'MAIN' to execute in the page's context, 'ISOLATED' (default) for content script context.
    });

    // Explicitly cast the result to the expected return type
    return results as chrome.scripting.InjectionResult<globalThis.Awaited<Result>>[];
  } catch (error) {
    console.error('Error executing script in tab:', options?.tab?.id, 'Error:', error);
    // Re-throw or handle as needed
    throw error;
  }
}
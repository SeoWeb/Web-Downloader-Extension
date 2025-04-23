export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0) {
    const activeTab = tabs[0];
    if (
      activeTab?.id &&
      activeTab.url &&
      activeTab.url !== "about:blank" &&
      !activeTab.url.startsWith("chrome://")
    ) {
      return activeTab;
    }
  }
  return null;
}

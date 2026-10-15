import { useEffect, useState } from "react";

/**
 * Why the active tab is unsupported. `null` when the tab is supported.
 * - "noTab": no active tab (or its URL is unknown)
 * - "unsupportedUrl": browser-internal page, Web Store, non-http(s), file://
 */
export type UnsupportedReason = "noTab" | "unsupportedUrl";

export interface ActiveTabInfo {
  tabId: number;
  tabUrl: string;
  supported: boolean;
  reason: UnsupportedReason | null;
}

interface UseActiveTabInfoProps {
  setTabId: (id: number) => void;
  setTabUrl: (url: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
}

/**
 * URL schemes the extension cannot script. `file://` is treated as
 * unsupported because the extension has no "Allow access to file URLs".
 */
const BLOCKED_PROTOCOLS = ["view-source:", "file:"];

const BLOCKED_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

/**
 * Validate a tab URL (task 5.1 / design D8).
 *
 * Only http/https pages can be scraped. This mirrors the validation used
 * by the download path so the panel never offers a Start control that is
 * doomed to fail. Intentionally lives in the hook — `getActiveTab` in
 * src/common has a different contract and is shared code.
 */
export function isTabUrlSupported(url: string): boolean {
  if (!url) return false;
  const lowered = url.toLowerCase();
  if (BLOCKED_PROTOCOLS.some((protocol) => lowered.startsWith(protocol))) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Excludes chrome://, edge://, about:, chrome-extension://, file://, etc.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.includes(host)) {
    // Legacy Web Store URLs live under chrome.google.com/webstore;
    // chromewebstore.google.com is the store itself.
    if (
      host === "chromewebstore.google.com" ||
      parsed.pathname.toLowerCase().startsWith("/webstore")
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Track the active tab and report whether it can be downloaded (5.1).
 *
 * Re-evaluates on `tabs.onActivated` (tab switch) and `tabs.onUpdated`
 * (navigation within the tracked tab) so the panel never shows a working
 * form for a page that cannot be scripted.
 */
export function useActiveTabInfo({
  setTabId,
  setTabUrl,
  setMessages,
}: UseActiveTabInfoProps): ActiveTabInfo {
  const [info, setInfo] = useState<ActiveTabInfo>({
    tabId: 0,
    tabUrl: "",
    supported: false,
    reason: "noTab",
  });

  useEffect(() => {
    let disposed = false;
    let trackedTabId = 0;

    const evaluateTab = async (tab: chrome.tabs.Tab | undefined) => {
      if (disposed || !tab || !tab.id) return;
      const tabId = tab.id;
      const tabUrl = tab.url ?? "";
      trackedTabId = tabId;
      setTabId(tabId);
      setTabUrl(tabUrl);

      const supported = isTabUrlSupported(tabUrl);
      setInfo({
        tabId,
        tabUrl,
        supported,
        reason: supported ? null : "unsupportedUrl",
      });

      if (supported) {
        setMessages((prev) =>
          prev.some(
            (m) => (typeof m === "string" ? m : m.key) === "status.connected",
          )
            ? prev
            : [...prev, { key: "status.connected" }],
        );
      }
    };

    const refreshActiveTab = async () => {
      try {
        const tabs = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        await evaluateTab(tabs[0]);
      } catch {
        // Tabs API unavailable — leave the initial state.
      }
    };

    const handleActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      // Only react if we know the newly activated tab — otherwise refresh.
      if (activeInfo?.tabId === trackedTabId) return;
      refreshActiveTab();
    };

    const handleUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ) => {
      if (updatedTabId === trackedTabId && changeInfo.url !== undefined) {
        refreshActiveTab();
      }
    };

    refreshActiveTab();
    chrome.tabs.onActivated.addListener(handleActivated);
    chrome.tabs.onUpdated.addListener(handleUpdated);

    return () => {
      disposed = true;
      chrome.tabs.onActivated.removeListener(handleActivated);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
    };
    // Setters are stable; run once like the original mount-only effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setMessages]);

  return info;
}

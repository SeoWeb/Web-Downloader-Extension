import { useEffect } from "react";
import { getActiveTab } from "../../common/chrome";

interface UseActiveTabInfoProps {
  setTabId: (id: number) => void;
  setTabUrl: (url: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<string[]>>;
}

export function useActiveTabInfo({
  setTabId,
  setTabUrl,
  setMessages,
}: UseActiveTabInfoProps) {
  useEffect(() => {
    // Fetch initial tab info only once on mount
    getActiveTab().then((tab) => {
      if (tab && tab.id && tab.url) {
        setTabId(tab.id);
        setTabUrl(tab.url);
        setMessages((prev) => [...prev, "Website connected!"]);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array ensures this runs only once
}

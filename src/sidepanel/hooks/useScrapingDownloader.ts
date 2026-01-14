import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  handleStartScroll,
  handleStartDownload,
} from "../utils/messageHandlers";
import { mergeDownloadResponse } from "../utils/downloadUtils";

export interface DownloadOptions {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadDocuments: boolean;
  singleFile: boolean;
}

export interface ScrollingResponse {
  height?: number;
  html?: string;
  top?: number;
  viewportHeight?: number;
}

interface UseScrapingDownloaderProps {
  tabId: number;
  tabUrl: string;
  isScraping: boolean;
  setIsScraping: React.Dispatch<React.SetStateAction<boolean>>;
  downloadOptions: DownloadOptions | null;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
}

export function useScrapingDownloader({
  tabId,
  tabUrl,
  isScraping,
  setIsScraping,
  downloadOptions,
  setMessages,
}: UseScrapingDownloaderProps) {
  const { t } = useTranslation();
  const [downloadResponse, setDownloadResponse] =
    useState<ScrollingResponse | null>(null);
  const [scrollAttempts, setScrollAttempts] = useState<number>(0);

  const startScrolling = useCallback(async (): Promise<
    ScrollingResponse | undefined
  > => {
    return handleStartScroll(
      tabId,
      (msg) => setMessages((prev) => [...prev, msg]),
      setIsScraping,
    );
  }, [tabId, setIsScraping, setMessages]);

  const startDownload = useCallback(
    async (html: string): Promise<string[] | undefined> => {
      return handleStartDownload(tabId, html, tabUrl, downloadOptions, (msg) =>
        setMessages((prev) => [...prev, msg]),
      );
    },
    [tabId, tabUrl, downloadOptions, setMessages],
  );

  const scrape = useCallback(async () => {
  if (!tabId) {
      setIsScraping(false);
      setMessages((prev) => [...prev, { key: "status.failedWithError", options: { error: t("app.invalidTabId") } }]);
      return;
    }

    const response = await startScrolling();

    if (response?.height && response.html) {
      setDownloadResponse((prev) => {
        const data = mergeDownloadResponse(prev, response);

        // Check if we've reached the bottom of the page
        const prevTop = prev?.top || 0;
        const currentTop = response.top || 0;
        const currentHeight = response.height || 0;
        
        // Calculate if we're at the bottom: scrollTop + viewport height >= total page height
        const viewportHeight = response.viewportHeight || 1000;
        const isAtBottom = currentTop + viewportHeight >= currentHeight - 100; // 100px buffer
        
        const scrollPositionChanged = Math.abs(currentTop - prevTop) > 10; // More than 10px change
        
        // Stop scrolling if:
        // 1. We're at the bottom of the page, OR
        // 2. Position hasn't changed (stuck), OR
        // 3. We've exceeded the safety limit
        if (isAtBottom) {
          setIsScraping(false);
        } else if (prev && !scrollPositionChanged) {
          setIsScraping(false);
        } else if (scrollAttempts >= 500) { // Increased safety limit for very long pages
          setIsScraping(false);
          setMessages((prev) => [...prev, { key: "app.maxScrollAttempts" }]);
        } else {
          // Continue scrolling
          setScrollAttempts((prevCount) => prevCount + 1);
        }

        return data;
      });
    } else {
      setIsScraping(false);
      setMessages((prev) => [...prev, { key: "status.failed" }]);
    }
  }, [tabId, startScrolling, setIsScraping, setMessages, scrollAttempts]);

  useEffect(() => {
    if (isScraping) {
      scrape();
    } else if (downloadResponse?.html && downloadOptions) {
      startDownload(downloadResponse.html)
        .then(() => {
          // Don't reset downloadResponse here - keep it to maintain filter hidden state
          // It will be cleared when DOWNLOAD_COMPLETE or DOWNLOAD_CANCELLED message is received
        })
        .catch(() => {
          setMessages((prev) => [...prev, { key: "status.failed" }]);
          // Reset on error
          setDownloadResponse(null);
        });
    }
  }, [
    isScraping,
    downloadResponse?.html,
    downloadOptions,
    scrape,
    startDownload,
    setMessages,
    setDownloadResponse,
  ]);

  return {
    downloadResponse,
    scrollAttempts,
    setDownloadResponse,
    setScrollAttempts,
  };
}

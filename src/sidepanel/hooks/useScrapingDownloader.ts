import { useEffect, useState, useCallback } from "react";
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
}

interface UseScrapingDownloaderProps {
  tabId: number;
  tabUrl: string;
  isScraping: boolean;
  setIsScraping: React.Dispatch<React.SetStateAction<boolean>>;
  downloadOptions: DownloadOptions | null;
  setMessages: React.Dispatch<React.SetStateAction<string[]>>;
  setDownloadDone: (links: string[]) => void;
}

export function useScrapingDownloader({
  tabId,
  tabUrl,
  isScraping,
  setIsScraping,
  downloadOptions,
  setMessages,
  setDownloadDone,
}: UseScrapingDownloaderProps) {
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
      setMessages((prev) => [...prev, "Invalid tab ID"]);
      return;
    }

    console.log("Starting scrolling for tab", tabId);
    const response = await startScrolling();
    console.log("Scrolling completed with response:", response);

    if (response?.height && response.html) {
      setDownloadResponse((prev) => {
        const prevTop = prev?.top || 0;
        const prevHeight = prev?.height || 0;
        const data = mergeDownloadResponse(prev, response);

        // Check if we've reached the bottom of the page
        // If scroll position hasn't changed significantly OR we've made too many attempts, stop scrolling
        const scrollPositionChanged = Math.abs((response.top || 0) - prevTop) > 10; // More than 10px change
        const contentHeightChanged = Math.abs((response.height || 0) - prevHeight) > 50; // More than 50px change
        
        if (!scrollPositionChanged && !contentHeightChanged) {
          console.log("Scroll position and content height unchanged, stopping scroll");
          setIsScraping(false);
        } else if (scrollAttempts >= 50) { // Safety limit to prevent infinite scrolling
          console.log("Maximum scroll attempts reached, stopping scroll");
          setIsScraping(false);
          setMessages((prev) => [...prev, "Maximum scroll attempts reached"]);
        } else {
          setScrollAttempts((prevCount) => prevCount + 1);
        }

        return data;
      });
    } else {
      setIsScraping(false);
      setMessages((prev) => [...prev, "Scraping failed or stopped"]);
    }
  }, [tabId, startScrolling, setIsScraping, setMessages, scrollAttempts]);

  useEffect(() => {
    if (isScraping) {
      scrape();
    } else if (downloadResponse?.html && downloadOptions) {
      console.log("Starting download with HTML content");
      startDownload(downloadResponse.html)
        .then((links) => {
          console.log("Download completed successfully with links:", links);
          setDownloadDone(links || []);
          setDownloadResponse(null);
        })
        .catch((error) => {
          console.error("Download failed:", error);
          setMessages((prev) => [...prev, "Failed to complete download"]);
        });
    }
  }, [
    isScraping,
    scrollAttempts,
    downloadResponse?.html,
    downloadOptions,
    scrape,
    startDownload,
    setDownloadDone,
    setMessages,
  ]);

  return {
    downloadResponse,
    scrollAttempts,
    setDownloadResponse,
    setScrollAttempts,
  };
}

import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  handleStartScroll,
  handleStartDownload,
} from "../utils/messageHandlers";
import { mergeDownloadResponse } from "../utils/downloadUtils";
import { sendMessageToBackground } from "../../client/message";
import { messageActions } from "../../common/message";
import { IS_SERVER_MODE } from "../../common/server-mode";

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

  // (13.3) In server mode, track the server session ID and scroll index
  // for streaming HTML chunks during scrolling instead of accumulating
  // the full HTML in downloadResponse.
  const serverSessionIdRef = useRef<string | null>(null);
  const serverScrollIndexRef = useRef<number>(0);
  // Track whether we've created a server session during this scraping session
  const serverSessionCreatedRef = useRef<boolean>(false);
  // In server mode, track the last scroll response's HTML for resource extraction
  // (we still need it for the download phase, but we don't accumulate ALL chunks)
  const lastHtmlRef = useRef<string>("");
  // Flag: scrolling is done and HTML has been fully streamed to the server
  const [serverStreamingDone, setServerStreamingDone] = useState<boolean>(false);

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

    // (13.3) In server mode, create a server session before the first scroll
    // so that HTML chunks can be streamed in real-time.
    if (IS_SERVER_MODE && !serverSessionCreatedRef.current) {
      try {
        const result = await sendMessageToBackground(
          messageActions.SERVER_CREATE_SESSION,
          {
            url: tabUrl,
            options: {
              singleFile: downloadOptions?.singleFile ?? false,
              retentionDays: 7,
            },
            setActive: true, // Store as active session in background
          },
        );
        if (result?.success && result.sessionId) {
          serverSessionIdRef.current = result.sessionId;
          serverScrollIndexRef.current = 0;
          serverSessionCreatedRef.current = true;
        } else {
          // Failed to create server session — fall back to local accumulation
          setMessages((prev) => [...prev, { key: "status.serverSessionFailed", options: { error: result?.error } }]);
        }
      } catch {
        // Failed to create server session — fall back to local accumulation
      }
    }

    const response = await startScrolling();

    if (response?.height && response.html) {
      // (13.3) In server mode, stream the HTML chunk to the server immediately
      // instead of accumulating it in downloadResponse. This prevents memory
      // buildup for long pages with many scroll iterations.
      if (IS_SERVER_MODE && serverSessionIdRef.current) {
        try {
          await sendMessageToBackground(
            messageActions.SERVER_UPLOAD_HTML_CHUNK,
            {
              sessionId: serverSessionIdRef.current,
              html: response.html,
              scrollIndex: serverScrollIndexRef.current++,
              pageType: "main",
              pageUrl: tabUrl,
            },
          );
        } catch {
          // Upload failed — continue scrolling; the download phase will
          // handle the error when it tries to finalize the session.
        }
        // Keep only the last HTML for resource extraction (not accumulated)
        lastHtmlRef.current = response.html;
      }

      setDownloadResponse((prev) => {
        // (13.3) In server mode, don't accumulate HTML — only track scroll metadata.
        // The HTML has already been streamed to the server.
        const data = IS_SERVER_MODE && serverSessionIdRef.current
          ? { top: response.top, height: response.height, viewportHeight: response.viewportHeight }
          : mergeDownloadResponse(prev, response);

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
  }, [tabId, tabUrl, startScrolling, setIsScraping, setMessages, scrollAttempts, downloadOptions?.singleFile]);

  useEffect(() => {
    if (isScraping) {
      scrape();
    } else if (downloadOptions) {
      // (13.3) In server mode, HTML chunks have already been streamed to
      // the server during scrolling. We pass the LAST scroll response's HTML
      // to startDownload so that download-core.ts can extract resource URLs
      // from it. The actual HTML content is already on the server.
      //
      // In local mode, the full accumulated HTML is in downloadResponse.html.
      const htmlForDownload = IS_SERVER_MODE && serverSessionIdRef.current
        ? lastHtmlRef.current
        : downloadResponse?.html;

      if (htmlForDownload) {
        startDownload(htmlForDownload)
          .then(() => {
            // (13.3) Mark streaming as done in server mode
            if (IS_SERVER_MODE && serverSessionIdRef.current) {
              setServerStreamingDone(true);
            }
            // Don't reset downloadResponse here - keep it to maintain filter hidden state
            // It will be cleared when DOWNLOAD_COMPLETE or DOWNLOAD_CANCELLED message is received
          })
          .catch(() => {
            setMessages((prev) => [...prev, { key: "status.failed" }]);
            // Reset on error
            setDownloadResponse(null);
          });
      }
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
    setDownloadResponse: (value: React.SetStateAction<ScrollingResponse | null>) => {
      setDownloadResponse(value);
      // (13.3) Reset server streaming state when downloadResponse is cleared
      // (e.g., when a new download starts or the current one completes/cancels)
      if (value === null) {
        serverSessionIdRef.current = null;
        serverScrollIndexRef.current = 0;
        serverSessionCreatedRef.current = false;
        lastHtmlRef.current = "";
        setServerStreamingDone(false);
      }
    },
    setScrollAttempts,
    serverStreamingDone,
  };
}

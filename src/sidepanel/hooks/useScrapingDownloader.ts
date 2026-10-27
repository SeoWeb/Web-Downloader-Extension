import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  handleStartScroll,
  handleStartDownload,
} from "../utils/messageHandlers";
import { mergeDownloadResponse } from "../utils/downloadUtils";
import { sendMessageToBackground } from "../../client/message";
import { messageActions } from "../../common/message";

export interface DownloadOptions {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadContentAsMarkdown?: boolean;
  downloadDocuments: boolean;
  downloadLinksFullScraping?: boolean;
  singleFile: boolean;
}

export interface ScrollingResponse {
  height?: number;
  html?: string;
  top?: number;
  viewportHeight?: number;
  /** Whether the page's scrollHeight changed during the last scroll step. */
  heightChanged?: boolean;
  /** (Fix C — hydration window) ms since the first scroll step of this run. */
  hydrationElapsedMs?: number;
  /** (Fix C — hydration window) visible <img> elements still loading. */
  imagesPending?: number;
}

// ---------------------------------------------------------------------------
// (Fix C — hydration window) Early-stop parameters.
//
// A page that is still hydrating presents a short skeleton DOM: the first
// scroll step is instantly "at bottom" with no growth, which the previous
// logic read as settled — producing 0-resource downloads. The stop decision
// therefore requires ALL of:
//   1. the existing bottom/no-growth/no-motion conditions,
//   2. at least MIN_SETTLES_BEFORE_STOP consecutive no-growth settles,
//   3. at least MIN_SCRAPE_DURATION_MS elapsed since the first scroll step,
//   4. no visible <img> still loading — OR IMAGE_SETTLE_CAP_MS elapsed, so
//      a single slow image can never stall the scrape indefinitely.
// The max-scroll-attempts safety stop is intentionally NOT gated by the
// window. Linked-page scraping runs its own inline scroll script and is
// unaffected.
// ---------------------------------------------------------------------------

/** Minimum elapsed time before an early stop is allowed (hydration floor). */
export const MIN_SCRAPE_DURATION_MS = 1800;
/** Consecutive no-growth settles required before an early stop. */
export const MIN_SETTLES_BEFORE_STOP = 2;
/**
 * Cap for the pending-image wait: past this, stop even if images are still
 * loading (one forever-spinning image must not stall the download).
 */
export const IMAGE_SETTLE_CAP_MS = 10000;

/** Inputs for the pure early-stop decision (extracted for unit testing). */
export interface ScrollStopDecisionInput {
  /** Previous scroll response (null on the first step). */
  prev: ScrollingResponse | null;
  /** Current scroll response. */
  response: ScrollingResponse;
  /** Previous page height (prevHeightRef value BEFORE this step). */
  prevHeight: number;
  /** Current consecutive-settle count BEFORE this step. */
  settleCount: number;
  /** Scroll attempts completed so far (safety limit input). */
  scrollAttempts: number;
  /** Safety limit for very long pages. */
  maxScrollAttempts?: number;
  /** Minimum elapsed time before an early stop is allowed. */
  minDurationMs?: number;
  /** Consecutive no-growth settles required before an early stop. */
  minSettles?: number;
  /** Cap for the pending-image wait. */
  imageCapMs?: number;
}

export interface ScrollStopDecision {
  /** Stop scrolling (page settled, stuck, or safety limit). */
  stop: boolean;
  /** Safety limit reached — the caller adds a user-facing message. */
  maxScrollAttemptsReached: boolean;
  /** Which condition produced the stop (diagnostics/tests). */
  reason: "settled" | "stuck" | "maxAttempts" | null;
  /** New height baseline to store in prevHeightRef. */
  nextPrevHeight: number;
  /** New settle count to store in settleCountRef. */
  nextSettleCount: number;
}

/**
 * Pure early-stop decision for the main-page scroll loop (Fix C).
 *
 * Preserves the previous behavior exactly (bottom/no-growth settle logic,
 * stuck detection, 500-step safety limit) and ADDs the hydration-window
 * constraints: the "settled" and "stuck" stops only fire once the page has
 * had a minimum time to hydrate and no visible <img> is still loading
 * (bounded by the time cap).
 */
export function decideScrollStop({
  prev,
  response,
  prevHeight,
  settleCount,
  scrollAttempts,
  maxScrollAttempts = 500,
  minDurationMs = MIN_SCRAPE_DURATION_MS,
  minSettles = MIN_SETTLES_BEFORE_STOP,
  imageCapMs = IMAGE_SETTLE_CAP_MS,
}: ScrollStopDecisionInput): ScrollStopDecision {
  const prevTop = prev?.top || 0;
  const currentTop = response.top || 0;
  const currentHeight = response.height || 0;
  const heightChanged = response.heightChanged ?? false;

  // Calculate if we're at the bottom of the page
  const viewportHeight = response.viewportHeight || 1000;
  const isAtBottom = currentTop + viewportHeight >= currentHeight - 100; // 100px buffer

  const scrollPositionChanged = Math.abs(currentTop - prevTop) > 10; // More than 10px change

  // Page-growth awareness: if height increased, don't stop even if at bottom
  const pageGrew = currentHeight > prevHeight;

  // Settle mechanism: when at bottom, wait more iterations to confirm
  // the page isn't still growing.
  let nextSettleCount: number;
  if (isAtBottom) {
    nextSettleCount = pageGrew || heightChanged ? 0 : settleCount + 1;
  } else {
    nextSettleCount = 0;
  }

  // (Fix C) Hydration window: elapsed time since the first scroll step and
  // pending-image state gate the "settled"/"stuck" early stops. Undefined
  // elapsed (older responses / direct callers) is treated as "window not
  // yet satisfied" ONLY when a duration floor is configured — a zero floor
  // keeps the legacy behavior for tests that opt out.
  const elapsed = response.hydrationElapsedMs ?? 0;
  const imagesPending = response.imagesPending ?? 0;
  const hydrationSettled =
    elapsed >= minDurationMs && (imagesPending === 0 || elapsed >= imageCapMs);

  const settledStop =
    isAtBottom &&
    !pageGrew &&
    !heightChanged &&
    !scrollPositionChanged &&
    nextSettleCount >= minSettles &&
    hydrationSettled;
  const stuckStop =
    !!prev && !scrollPositionChanged && !pageGrew && hydrationSettled;

  if (settledStop) {
    return {
      stop: true,
      maxScrollAttemptsReached: false,
      reason: "settled",
      nextPrevHeight: currentHeight,
      nextSettleCount,
    };
  }
  if (stuckStop) {
    return {
      stop: true,
      maxScrollAttemptsReached: false,
      reason: "stuck",
      nextPrevHeight: currentHeight,
      nextSettleCount,
    };
  }
  if (scrollAttempts >= maxScrollAttempts) {
    return {
      stop: true,
      maxScrollAttemptsReached: true,
      reason: "maxAttempts",
      nextPrevHeight: currentHeight,
      nextSettleCount,
    };
  }
  return {
    stop: false,
    maxScrollAttemptsReached: false,
    reason: null,
    nextPrevHeight: currentHeight,
    nextSettleCount,
  };
}

interface UseScrapingDownloaderProps {
  tabId: number;
  tabUrl: string;
  isScraping: boolean;
  setIsScraping: React.Dispatch<React.SetStateAction<boolean>>;
  downloadOptions: DownloadOptions | null;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  /** (5.5) Called when the user stops mid-scrape and a partial save proceeds. */
  onPartialSave?: () => void;
}

export function useScrapingDownloader({
  tabId,
  tabUrl,
  isScraping,
  setIsScraping,
  downloadOptions,
  setMessages,
  onPartialSave,
}: UseScrapingDownloaderProps) {
  const { t } = useTranslation();
  const [downloadResponse, setDownloadResponse] =
    useState<ScrollingResponse | null>(null);
  const [scrollAttempts, setScrollAttempts] = useState<number>(0);

  // Track previous height for page-growth-aware bottom detection
  const prevHeightRef = useRef<number>(0);
  // Settle mechanism: when we first reach the bottom, wait one more
  // iteration to see if the page grows before declaring "at bottom"
  const settleCountRef = useRef<number>(0);
  const stoppedByUserRef = useRef<boolean>(false);
  const isScrapingRef = useRef(isScraping);
  isScrapingRef.current = isScraping;

  // ---------------------------------------------------------------------
  // (Fix A — replay loop) Single-fire gate + press-time tab pinning.
  //
  // The download effect used to re-run on EVERY render whose dependencies
  // changed (fresh `scrape`/`startDownload` identities, live tabId/tabUrl,
  // downloadResponse.html) and replayed START_DOWNLOAD each time — a tab
  // switch mid-flow retargeted the replay at the newly focused tab while
  // carrying the ORIGINAL tab's html, creating server sessions for pages
  // the user never requested (one press → five sessions incident).
  //
  // Two mechanisms close that hole:
  //   1. `downloadStartedRef` — a started gate. START_DOWNLOAD fires at
  //      most ONCE per intentional run; it is reset only when a new run
  //      begins (the isScraping false→true transition of a fresh press or
  //      retry). Dependency identity churn can no longer replay it.
  //   2. `targetRef` — the tab snapshot taken AT PRESS TIME (the render in
  //      which isScraping flips true). Every background interaction of the
  //      flow (scrolling, session creation, chunk streaming, START_DOWNLOAD,
  //      stop) uses this snapshot — never the live useActiveTabInfo values —
  //      so a tab switch mid-flow cannot retarget anything.
  // ---------------------------------------------------------------------
  const downloadStartedRef = useRef<boolean>(false);
  /** True while a press-initiated run is in flight (isScraping true). */
  const runActiveRef = useRef<boolean>(false);
  /** Press-time tab snapshot — pinned for the whole run. */
  const targetRef = useRef<{ tabId: number; tabUrl: string }>({
    tabId: 0,
    tabUrl: "",
  });
  // Render-time mirror of the live tab values (read only when a NEW run
  // starts, i.e. at press time — mirrors the actionRef pattern above).
  const liveTabRef = useRef<{ tabId: number; tabUrl: string }>({
    tabId,
    tabUrl,
  });
  liveTabRef.current = { tabId, tabUrl };
  // Options mirror so stable callbacks always see the current options
  // without identity churn.
  const downloadOptionsRef = useRef<DownloadOptions | null>(downloadOptions);
  downloadOptionsRef.current = downloadOptions;

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
  const [serverStreamingDone, setServerStreamingDone] =
    useState<boolean>(false);

  const startScrolling = useCallback(async (): Promise<
    ScrollingResponse | undefined
  > => {
    // (Fix A) Always scroll the PRESS-TIME tab, never the focused one.
    return handleStartScroll(
      targetRef.current.tabId,
      (msg) => setMessages((prev) => [...prev, msg]),
      setIsScraping,
    );
  }, [setIsScraping, setMessages]);

  const startDownload = useCallback(
    async (html: string): Promise<string[] | undefined> => {
      // (Fix A) START_DOWNLOAD carries the PRESS-TIME tab snapshot — a tab
      // switch mid-flow can no longer retarget the download.
      const target = targetRef.current;
      return handleStartDownload(
        target.tabId,
        html,
        target.tabUrl,
        downloadOptionsRef.current,
        (msg) => setMessages((prev) => [...prev, msg]),
      );
    },
    [setMessages],
  );

  const stopScraping = useCallback(async () => {
    await sendMessageToBackground(messageActions.SCRAPER_STOP, {
      tabId: targetRef.current.tabId,
    });
    if (isScrapingRef.current) {
      stoppedByUserRef.current = true;
      // (5.5) Partial save: communicate what is happening instead of
      // silently packaging the content captured so far.
      setMessages((prev) => [...prev, { key: "status.savingPartialCapture" }]);
      onPartialSave?.();
    }
    setIsScraping(false);
  }, [setIsScraping, setMessages, onPartialSave]);

  const scrape = useCallback(async () => {
    // (Fix A) The whole flow runs against the press-time snapshot.
    const target = targetRef.current;
    if (!target.tabId) {
      setIsScraping(false);
      setMessages((prev) => [
        ...prev,
        {
          key: "status.failedWithError",
          options: { error: t("app.invalidTabId") },
        },
      ]);
      return;
    }

    // (13.3) Create a server session before the first scroll
    // so that HTML chunks can be streamed in real-time.
    if (!serverSessionCreatedRef.current) {
      try {
        const result = await sendMessageToBackground(
          messageActions.SERVER_CREATE_SESSION,
          {
            url: target.tabUrl,
            options: {
              singleFile: downloadOptionsRef.current?.singleFile ?? false,
              // Forwarded so the pre-created session (reused by
              // download-core) carries the markdown option too.
              downloadContentAsMarkdown:
                downloadOptionsRef.current?.downloadContentAsMarkdown ?? false,
              // text-native-downloads 6.1: the HTML/text flags ride the
              // pre-created session as well — download-core reuses it
              // instead of creating a new one.
              downloadHtml: downloadOptionsRef.current?.downloadHTML ?? true,
              downloadContentAsText:
                downloadOptionsRef.current?.downloadContentAsText ?? false,
              retentionDays: 1,
            },
            setActive: true, // Store as active session in background
          },
        );
        if (result?.success && result.sessionId) {
          serverSessionIdRef.current = result.sessionId;
          serverScrollIndexRef.current = 0;
          serverSessionCreatedRef.current = true;
        } else if (result?.error) {
          // Failed to create server session — show error only for real failures
          setMessages((prev) => [
            ...prev,
            {
              key: "status.serverSessionFailed",
              options: { error: result.error },
            },
          ]);
        }
      } catch {
        // Failed to create server session — fall back to local accumulation
      }
    }

    const response = await startScrolling();

    if (response?.height && response.html) {
      // (13.3) Stream the HTML chunk to the server immediately
      // instead of accumulating it in downloadResponse.
      if (serverSessionIdRef.current) {
        let chunkUploadFailed = false;
        try {
          const result = await sendMessageToBackground(
            messageActions.SERVER_UPLOAD_HTML_CHUNK,
            {
              sessionId: serverSessionIdRef.current,
              html: response.html,
              scrollIndex: serverScrollIndexRef.current++,
              pageType: "main",
              // Do NOT send pageUrl — the server defaults to page_url_hash="main"
              // when pageUrl is absent, which groups all scroll chunks into the
              // same job as the download-phase chunk. Sending pageUrl would create
              // a phantom linked page job with duplicated body content.
            },
          );
          // (Task 4.5) The background returns {success:false, error} when a
          // chunk exhausts its retries — surface it instead of silently
          // continuing (which would leave a gap in the archived page).
          if (result && result.success === false) {
            chunkUploadFailed = true;
            setMessages((prev) => [
              ...prev,
              {
                key: "status.failedWithError",
                options: {
                  error:
                    result.error || "HTML chunk upload failed after retries",
                },
              },
            ]);
          }
        } catch (err) {
          chunkUploadFailed = true;
          setMessages((prev) => [
            ...prev,
            {
              key: "status.failedWithError",
              options: {
                error:
                  err instanceof Error
                    ? err.message
                    : "HTML chunk upload failed",
              },
            },
          ]);
        }
        if (chunkUploadFailed) {
          // Mark the session incomplete: stop scrolling and surface the
          // error state. The partial content still finalizes so the user
          // gets what was captured, and the completion report reflects
          // the missing chunk.
          setIsScraping(false);
          return undefined;
        }
        // Keep only the last HTML for resource extraction (not accumulated)
        lastHtmlRef.current = response.html;
      }

      setDownloadResponse((prev) => {
        // (13.3) In server mode, don't accumulate HTML — only track scroll metadata.
        // The HTML has already been streamed to the server.
        const data = serverSessionIdRef.current
          ? {
              top: response.top,
              height: response.height,
              viewportHeight: response.viewportHeight,
              // (Fix C) Hydration-window fields ride along so the stop
              // decision below sees the CURRENT page state.
              hydrationElapsedMs: response.hydrationElapsedMs,
              imagesPending: response.imagesPending,
            }
          : mergeDownloadResponse(prev, response);

        // (Fix C — hydration window) Pure stop decision, extracted for unit
        // testing. Preserves the bottom/stuck/safety-limit logic and adds
        // the minimum-duration + image-settle constraints.
        const decision = decideScrollStop({
          prev,
          response: { ...response, ...data },
          prevHeight: prevHeightRef.current,
          settleCount: settleCountRef.current,
          scrollAttempts,
        });
        prevHeightRef.current = decision.nextPrevHeight;
        settleCountRef.current = decision.nextSettleCount;

        if (decision.stop) {
          setIsScraping(false);
          if (decision.maxScrollAttemptsReached) {
            setMessages((prev) => [...prev, { key: "app.maxScrollAttempts" }]);
          }
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
  }, [
    startScrolling,
    setIsScraping,
    setMessages,
    setDownloadResponse,
    scrollAttempts,
    t,
  ]);

  // ---------------------------------------------------------------------
  // Effect 1 — scroll driver (loop mechanics unchanged).
  //
  // The loop is driven by `scrape`'s identity changing per iteration
  // (scrollAttempts state → new callback → effect re-runs → next step).
  // On the FIRST invocation of a run (runActiveRef false) this is a fresh
  // press/retry: reset the single-fire gate and pin the press-time tab
  // snapshot. Later invocations within the same run NEVER re-snapshot, so
  // a mid-run tab switch cannot retarget anything.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (isScraping) {
      if (!runActiveRef.current) {
        runActiveRef.current = true;
        downloadStartedRef.current = false;
        stoppedByUserRef.current = false;
        // (Fix A) Press-time snapshot of tabId/tabUrl.
        targetRef.current = { ...liveTabRef.current };
      }
      scrape();
    } else {
      runActiveRef.current = false;
    }
  }, [isScraping, scrape]);

  // ---------------------------------------------------------------------
  // Effect 2 — START_DOWNLOAD, exactly once per intentional run (Fix A).
  //
  // `downloadStartedRef` gates BOTH the stop-partial-save path and the
  // normal path: once a START_DOWNLOAD has been sent for this run, no
  // dependency change (tab switch, fresh callback identities, options
  // updates, downloadResponse churn) can send another. The gate resets
  // only when a NEW run begins (Effect 1's run-start branch).
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (isScraping) return; // run in progress — scrolling drives this effect
    if (!downloadOptions) return; // no intentional run
    if (downloadStartedRef.current) return; // (Fix A) already fired this run

    if (stoppedByUserRef.current) {
      stoppedByUserRef.current = false;

      const htmlForStopDownload = serverSessionIdRef.current
        ? lastHtmlRef.current
        : downloadResponse?.html;

      if (htmlForStopDownload) {
        downloadStartedRef.current = true;
        const stopOptions = {
          ...downloadOptions,
          downloadLinks: false,
          downloadLinksFullScraping: false,
        };
        handleStartDownload(
          targetRef.current.tabId,
          htmlForStopDownload,
          targetRef.current.tabUrl,
          stopOptions,
          (msg) => setMessages((prev) => [...prev, msg]),
        )
          .then(() => {
            if (serverSessionIdRef.current) {
              setServerStreamingDone(true);
            }
          })
          .catch(() => {
            setMessages((prev) => [...prev, { key: "status.failed" }]);
            setDownloadResponse(null);
          });
      }
      return;
    }

    // (13.3) In server mode, HTML chunks have already been streamed to
    // the server during scrolling. We pass the LAST scroll response's HTML
    // to startDownload so that download-core.ts can extract resource URLs
    // from it. The actual HTML content is already on the server.
    const htmlForDownload = serverSessionIdRef.current
      ? lastHtmlRef.current
      : downloadResponse?.html;

    if (htmlForDownload) {
      // (Fix A) The ONE START_DOWNLOAD of this run.
      downloadStartedRef.current = true;
      startDownload(htmlForDownload)
        .then(() => {
          // (13.3) Mark streaming as done
          if (serverSessionIdRef.current) {
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
  }, [
    isScraping,
    downloadResponse?.html,
    downloadOptions,
    startDownload,
    setMessages,
    setDownloadResponse,
  ]);

  return {
    downloadResponse,
    lastHtml: lastHtmlRef.current,
    scrollAttempts,
    stopScraping,
    setDownloadResponse: (
      value: React.SetStateAction<ScrollingResponse | null>,
    ) => {
      setDownloadResponse(value);
      // (13.3) Reset server streaming state when downloadResponse is cleared
      // (e.g., when a new download starts or the current one completes/cancels)
      if (value === null) {
        serverSessionIdRef.current = null;
        serverScrollIndexRef.current = 0;
        serverSessionCreatedRef.current = false;
        lastHtmlRef.current = "";
        setServerStreamingDone(false);
        // Reset page-growth and settle tracking for next session
        prevHeightRef.current = 0;
        settleCountRef.current = 0;
      }
    },
    setScrollAttempts,
    serverStreamingDone,
  };
}

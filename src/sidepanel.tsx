import React, { useState, useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import "./styles/rtl.css"; // RTL support styles
import "./i18n/config"; // Initialize i18n
import { useTranslation } from "react-i18next";
import { MessageAction, messageActions } from "./common/message";
import { Message } from "./components/Actions";
import { MainContent } from "./sidepanel/components/MainContent";
import {
  DownloadStatus,
  InterruptData,
} from "./sidepanel/components/DownloadStatus";
import { DownloadComplete } from "./sidepanel/components/DownloadComplete";
import { useActiveTabInfo } from "./sidepanel/hooks/useActiveTabInfo"; // Added hook import
import { useMessageListener } from "./sidepanel/hooks/useMessageListener"; // Added hook import
import { useScrapingDownloader } from "./sidepanel/hooks/useScrapingDownloader"; // Added hook import

import { sendMessageToBackground } from "./client/message";
import {
  assertSecureBaseUrl,
  serverClient,
  upgradeInsecureServerUrl,
} from "./background/server-client";
import type { DownloadLiveSnapshot } from "./background/download-state";
import { isPushForPanel } from "./sidepanel/utils/tabFilter";
import { decideLivePollStep } from "./sidepanel/utils/livePolling";
import {
  ServerModeState,
  initialServerModeState,
  applyServerModeMessage,
} from "./sidepanel/server-mode-state";
import { usePagePocket } from "./hooks/usePagePocket";
import { CloudUploadState } from "./components/CloudUploadStatus";
import { PagePocketAnnouncement } from "./components/PagePocketAnnouncement";
import {
  DownloadReport,
  initialDownloadReport,
  applyDownloadReportMessage,
} from "./sidepanel/utils/downloadReport";

// ServerModeState type and transition logic are imported from
// server-mode-state.ts to avoid duplication and enable unit testing.

interface Options {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadDocuments: boolean;
  singleFile: boolean;
  alwaysAskWhereToSave?: boolean;
}

function ErrorFallback({
  error,
  resetErrorBoundary,
}: {
  error: Error;
  resetErrorBoundary: () => void;
}) {
  const { t } = useTranslation();

  // (5.6) Never print raw error details to the user — show a localized
  // generic message and log the details to the console instead.
  useEffect(() => {
    console.error("[SidePanel] Render error:", error);
  }, [error]);

  return (
    <div role="alert" className="p-4 bg-red-100 rounded">
      <p className="font-bold text-red-800">{t("app.error")}</p>
      <p className="text-red-600">{t("app.unexpectedError")}</p>
      <button
        onClick={resetErrorBoundary}
        className="mt-2 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
      >
        {t("app.tryAgain")}
      </button>
    </div>
  );
}

export default function SidePanel() {
  const { t } = useTranslation();
  const [tabId, setTabId] = useState<number>(0);
  const [tabUrl, setTabUrl] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([
    { key: "status.waiting" },
  ]);
  const [action, setAction] = useState<MessageAction | null>(null);
  const actionRef = useRef<MessageAction | null>(null);
  actionRef.current = action;
  const [links, setLinks] = useState<string[]>([]);
  const [isScraping, setIsScraping] = useState<boolean>(false);
  const [isScrapingLinkedPages, setIsScrapingLinkedPages] =
    useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  // (15.1–15.7) Server-mode UI state
  const [serverModeState, setServerModeState] = useState<ServerModeState>(
    initialServerModeState,
  );
  // Interrupt state: shown when the service worker was killed during a download
  const [interruptData, setInterruptData] = useState<InterruptData | null>(
    null,
  );
  // (Fix D.1) Server session id of a download that is CURRENTLY LIVE.
  // A checkpoint exists for the whole run, so a panel (re)opened mid-download
  // must show "download in progress" — not the Resume/Restart card.
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  // (Round 9 — Fix B) Trusted progress polled from CHECK_DOWNLOAD_LIVE.
  // Pushed progress messages are dropped whenever the focused tab changes,
  // so the downloading card can freeze on a stale count — this snapshot is
  // the trustworthy source instead.
  const [liveProgress, setLiveProgress] = useState<DownloadLiveSnapshot | null>(
    null,
  );
  // (Round 9 — Fix B) Session tracked by the poll: the reopened live
  // download's session (Fix D.1 mount flow) or the press-run's server
  // session once START_DOWNLOAD fires (download phase). Null = not tracking.
  const [pollSessionId, setPollSessionId] = useState<string | null>(null);
  // (Round 9) Poll bookkeeping — see the polling effect below.
  const sawLiveRef = useRef(false);
  const downloadSettledRef = useRef(false);
  const confirmPendingRef = useRef(false);
  // PagePocket cloud upload state
  const [cloudUploadState, setCloudUploadState] =
    useState<CloudUploadState | null>(null);
  // (5.3 + 5.5) Aggregated per-category download report for DownloadComplete
  const [downloadReport, setDownloadReport] = useState<DownloadReport>(
    initialDownloadReport,
  );
  // PagePocket auth/cloud state
  const { cloudStorageEnabled, isAuthenticated } = usePagePocket();
  // downloadResponse and scrollAttempts are now managed by useScrapingDownloader hook
  const [downloadOptions, setDownloadOptions] = useState<{
    downloadHTML: boolean;
    downloadImages: boolean;
    downloadLinks: boolean;
    downloadAssets: boolean;
    downloadContentAsText: boolean;
    downloadDocuments: boolean;
    singleFile: boolean;
  } | null>(null);

  // (5.1) Active tab support is validated inside the hook; the form is
  // replaced by the unsupported-page state when the tab can't be scraped.
  const { supported: tabSupported } = useActiveTabInfo({
    setTabId,
    setTabUrl,
    setMessages,
  });

  // Initialize useScrapingDownloader hook early so setDownloadResponse is available
  const {
    downloadResponse,
    setDownloadResponse,
    setScrollAttempts,
    stopScraping,
    getPinnedTabId,
    getServerSessionId,
  } = useScrapingDownloader({
    tabId,
    tabUrl,
    isScraping,
    setIsScraping,
    downloadOptions,
    setMessages,
    // (5.5) A user stop mid-scrape packages partial content — mark the
    // completion report so the outcome is explicit.
    onPartialSave: () => {
      setDownloadReport((prev) => ({ ...prev, partial: true }));
    },
    // (Round 9 — Fix B) Pin liveness polling to the download phase of this
    // press-run and re-arm the terminal detection for the new run.
    onDownloadStarted: (serverSessionId) => {
      sawLiveRef.current = false;
      downloadSettledRef.current = false;
      confirmPendingRef.current = false;
      setPollSessionId(serverSessionId);
    },
    // (Round 9 — Fix B) The START_DOWNLOAD promise settled — the run is
    // terminal-eligible even if no poll observed the session live.
    onDownloadSettled: () => {
      downloadSettledRef.current = true;
    },
  });

  // (Round 9 — Fix 3/4) Mirror the hook's press-time snapshot + session id
  // into refs every render, so the message filter and the poll loop always
  // read the CURRENT values without re-subscribing the message listener.
  const pinnedDownloadTabRef = useRef<number>(0);
  pinnedDownloadTabRef.current = getPinnedTabId();
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = getServerSessionId();

  // (Round 9 — Fix 3) Push acceptance: the focused tab OR the pinned
  // download tab. See isPushForPanel for the multi-tab semantics.
  const acceptsTab = useCallback(
    (senderTabId: number | undefined) =>
      isPushForPanel(senderTabId, tabId, pinnedDownloadTabRef.current),
    [tabId],
  );

  // Memoize messageWorker to stabilize useMessageListener dependency
  const messageWorker = useCallback(
    async (action: MessageAction, data: any): Promise<any> => {
      switch (action) {
        case messageActions.PANEL_PING:
          // Service worker is checking if we're alive
          return "PONG";

        case messageActions.PANEL_MESSAGE:
          // (Round 9 — Fix 3) Accept pushes for the focused tab OR for the
          // tab of the download this panel started (press-time snapshot).
          // The old filter compared against the live focused tab only, so
          // EVERY push from an active download — progress and the terminal
          // outcome alike — was dropped once the user switched tabs (the
          // panel froze at "Images progress: 1/353" while the server
          // received all images). Genuinely unrelated tabs' downloads are
          // still ignored; a newer press re-pins the snapshot.
          if (!acceptsTab(data.tabId)) break;
          setMessages((prev) => [...prev, data.message]);
          if (data.message?.options?.isPaused !== undefined) {
            setIsPaused(data.message.options.isPaused);
          }
          // Track linked page scraping state based on message keys
          if (data.message?.key === "status.scrapingLinkedPages") {
            setIsScrapingLinkedPages(true);
          } else if (data.message?.key === "status.creatingPackage") {
            setIsScrapingLinkedPages(false);
          }

          // PagePocket cloud upload state (via PANEL_MESSAGE from
          // download-core.ts executeDownloadServerMode — cloud result
          // detected via server status response).
          // The download pipeline sends these as regular PANEL_MESSAGEs,
          // not as dedicated PAGEPOCKET_UPLOAD_* actions.
          const ppKey = data.message?.key;
          if (ppKey === "status.pagepocketUploading") {
            setCloudUploadState({ status: "uploading", progress: 0 });
          } else if (ppKey === "status.pagepocketUploadProgress") {
            const { loaded = 0, total = 1 } = data.message?.options ?? {};
            const pct = total > 0 ? (loaded / total) * 100 : 0;
            setCloudUploadState((prev) =>
              prev
                ? { ...prev, progress: pct }
                : { status: "uploading", progress: pct },
            );
          } else if (ppKey === "status.pagepocketUploadComplete") {
            setCloudUploadState({
              status: "success",
              progress: 100,
              pageId: data.message?.options?.pageId,
            });
            setAction(messageActions.DOWNLOAD_DONE);
            setIsScraping(false);
            setIsScrapingLinkedPages(false);
            setDownloadResponse(null);
          } else if (ppKey === "status.pagepocketUploadError") {
            const opts = data.message?.options ?? {};
            setCloudUploadState({
              status: "error",
              progress: 0,
              errorMessage: opts.error,
              isQuotaError: opts.quotaExceeded ?? false,
            });
            setIsScraping(false);
            setIsScrapingLinkedPages(false);
          } else if (ppKey === "status.noDownloadableContent") {
            // (Fix C — zero-content abort) The background refused to
            // finalize an empty session. Reset to the connected state with
            // the warning visible so the user can retry (mirrors the
            // DOWNLOAD_FAILED reset).
            setMessages([
              { key: "status.connected" },
              { key: "status.noDownloadableContent" },
            ]);
            setIsScraping(false);
            setIsScrapingLinkedPages(false);
            setAction(null);
            setDownloadReport(initialDownloadReport);
            setDownloadResponse(null);
          }

          // (15.7) Track server-mode phase transitions from messages.
          // Delegates to applyServerModeMessage() pure function (testable).
          const msgKey = data.message?.key;
          if (msgKey) {
            // (Fix D.1) Any terminal background outcome ends the live state.
            // (Round 9) status.noDownloadableContent is also terminal (the
            // zero-content abort) — and every terminal outcome stops the
            // liveness poll, so the poll-driven finalize can't override the
            // push-driven outcome.
            if (
              msgKey === "status.complete" ||
              msgKey === "status.pagepocketUploadComplete" ||
              msgKey === "status.pagepocketUploadError" ||
              msgKey === "status.noDownloadableContent"
            ) {
              setLiveSessionId(null);
              setPollSessionId(null);
            }
            setServerModeState((prev) =>
              applyServerModeMessage(prev, msgKey, data.message?.options),
            );

            // (5.3 + 5.5) Aggregate per-category summaries and partial
            // finalization into the persistent download report.
            setDownloadReport((prev) =>
              applyDownloadReportMessage(prev, msgKey, data.message?.options),
            );
          }
          break;

        // PagePocket cloud upload message handling
        case messageActions.PAGEPOCKET_UPLOAD_START:
          if (!acceptsTab(data.tabId)) break;
          setCloudUploadState({ status: "uploading", progress: 0 });
          break;

        case messageActions.PAGEPOCKET_UPLOAD_PROGRESS:
          if (!acceptsTab(data.tabId)) break;
          setCloudUploadState((prev) =>
            prev ? { ...prev, progress: data.progress ?? prev.progress } : prev,
          );
          break;

        case messageActions.PAGEPOCKET_UPLOAD_COMPLETE:
          if (!acceptsTab(data.tabId)) break;
          setCloudUploadState({
            status: "success",
            progress: 100,
            pageId: data.pageId,
          });
          setAction(messageActions.DOWNLOAD_DONE);
          // (Fix D.1) The download is no longer live.
          setLiveSessionId(null);
          // (Round 9) Stop the liveness poll — terminal via push.
          setPollSessionId(null);
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setDownloadResponse(null);
          break;

        case messageActions.PAGEPOCKET_UPLOAD_ERROR:
          if (!acceptsTab(data.tabId)) break;
          setCloudUploadState({
            status: "error",
            progress: 0,
            errorMessage: data.error,
            isQuotaError: data.isQuotaError ?? false,
          });
          // (Fix D.1) The download is no longer live.
          setLiveSessionId(null);
          // (Round 9) Stop the liveness poll — terminal via push.
          setPollSessionId(null);
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          break;

        case messageActions.DOWNLOAD_COMPLETE:
          if (!acceptsTab(data.tabId)) break;
          // Download actually completed - file was saved
          setMessages((prev) => [...prev, { key: "status.scraped" }]);
          setAction(messageActions.DOWNLOAD_DONE);
          // (Fix D.1) The download is no longer live.
          setLiveSessionId(null);
          // (Round 9) Stop the liveness poll — terminal via push.
          setPollSessionId(null);
          setServerModeState((prev) =>
            prev ? { ...prev, phase: "ready" } : prev,
          );
          setMessages((prev) => [...prev, { key: "status.creating" }]);
          setMessages((prev) => [...prev, { key: "status.complete" }]);
          // Store download ID for "Show in folder" functionality
          if (data.downloadId) {
            chrome.storage.local.set({ lastDownloadId: data.downloadId });
          }
          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);
          // Stop scraping state to show completion UI
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          break;

        case messageActions.DOWNLOAD_FAILED:
          if (!acceptsTab(data.tabId)) break;
          // Download failed or was interrupted
          // Reset messages to connected status with error message
          setMessages([
            { key: "status.connected" },
            {
              key: "status.failedWithError",
              options: { error: data.error || t("app.unknownError") },
            },
          ]);
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setAction(null);
          // (Fix D.1) The download is no longer live.
          setLiveSessionId(null);
          // (Round 9) Stop the liveness poll — terminal via push.
          setPollSessionId(null);
          // (5.3) A failed download leaves no completion screen — drop the
          // partial report collected so far.
          setDownloadReport(initialDownloadReport);
          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);
          break;

        case messageActions.DOWNLOAD_CANCELLED:
          if (!acceptsTab(data.tabId)) break;
          // (5.5) Full cancel — show explicit feedback instead of silently
          // resetting to the connected state.
          setMessages([
            { key: "status.connected" },
            { key: "status.cancelled" },
          ]);
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setAction(null);
          // (Fix D.1) The download is no longer live.
          setLiveSessionId(null);
          // (Round 9) Stop the liveness poll — terminal via push.
          setPollSessionId(null);
          setDownloadReport(initialDownloadReport);
          setDownloadResponse(null);
          break;

        case messageActions.DOWNLOAD_INTERRUPTED:
          // Service worker was killed during an active download
          setInterruptData({
            phase: data.phase || "scraping",
            tabUrl: data.tabUrl || "",
            timestamp: data.timestamp || Date.now(),
            serverSessionId: data.serverSessionId,
            resourceUrls: data.resourceUrls,
          });
          // (Fix D.1) An interrupted signal means the download is dead.
          setLiveSessionId(null);
          // (Round 9) Stop the liveness poll — terminal via push.
          setPollSessionId(null);
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setAction(null);
          setDownloadResponse(null);
          setMessages([
            { key: "status.connected" },
            {
              key: "status.downloadInterrupted",
              options: { phase: data.phase || "scraping" },
            },
          ]);
          break;

        default:
          break;
      }
      return null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [setDownloadResponse, acceptsTab],
  ); // Add setDownloadResponse to dependencies

  useMessageListener({ messageWorker });

  // Check for interrupted downloads on panel open
  useEffect(() => {
    (async () => {
      try {
        const result = await sendMessageToBackground(
          messageActions.CHECK_INTERRUPTED_DOWNLOAD,
          {},
        );
        if (result && result.downloadInterrupted) {
          // (Fix D.1 — liveness) A checkpoint exists for the WHOLE run, so a
          // checkpoint alone doesn't mean "interrupted". When the background
          // reports the session as LIVE, show the in-progress state instead
          // of the Resume/Restart card.
          if (result.serverSessionId) {
            try {
              const live = await sendMessageToBackground(
                messageActions.CHECK_DOWNLOAD_LIVE,
                { sessionId: result.serverSessionId },
              );
              if (live?.live) {
                setLiveSessionId(result.serverSessionId);
                // (Round 9 — Fix B) Track this session for liveness polling
                // so a terminal outcome that arrives via dropped pushes is
                // still surfaced.
                setPollSessionId(result.serverSessionId);
                setIsScraping(false);
                setIsScrapingLinkedPages(false);
                setMessages([
                  { key: "status.connected" },
                  { key: "status.downloadLive" },
                ]);
                return;
              }
            } catch {
              // Liveness query unavailable — fall through to the interrupt card
            }
          }
          setInterruptData({
            phase: result.phase || "scraping",
            tabUrl: result.tabUrl || "",
            timestamp: result.timestamp || Date.now(),
            serverSessionId: result.serverSessionId,
            resourceUrls: result.resourceUrls,
          });
          setIsScraping(false);
          setIsScrapingLinkedPages(false);
          setMessages([
            { key: "status.connected" },
            {
              key: "status.downloadInterrupted",
              options: { phase: result.phase || "scraping" },
            },
          ]);
        }
      } catch {
        // Background not ready yet — ignore
      }
    })();
  }, []); // Run once on mount

  // -------------------------------------------------------------------------
  // (Round 9 — Fix B) Liveness / progress polling.
  //
  // Pushed PANEL_MESSAGEs are dropped whenever the focused tab changes (the
  // old tabId filter), so the downloading card could freeze on a stale count
  // and a terminal failure was never shown. While a download is tracked —
  // the reopened live session, an active scrape, or a press-run after
  // START_DOWNLOAD — poll CHECK_DOWNLOAD_LIVE every 2.5s and:
  //   - publish the snapshot as the downloading card's trusted progress,
  //   - on live:false (once terminal-eligible: seen live, or START_DOWNLOAD
  //     settled) confirm with ONE more poll, then drive the terminal state:
  //     failure when the background recorded lastError, completion only when
  //     the download was actually observed live.
  // Push-driven terminals clear pollSessionId/liveSessionId, which stops
  // this loop — the poll is strictly the fallback for lost pushes.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const tracked =
      liveSessionId !== null || isScraping || pollSessionId !== null;
    if (!tracked) return;
    let cancelled = false;

    const snapshotSessionId =
      liveSessionId ?? pollSessionId ?? activeSessionIdRef.current ?? undefined;

    const finalizeAsFailure = (lastError: string) => {
      // Mirrors the DOWNLOAD_FAILED reset — the failure push was lost, so
      // the poll drives the same terminal state.
      setMessages([
        { key: "status.connected" },
        {
          key: "status.failedWithError",
          options: { error: lastError || t("app.unknownError") },
        },
      ]);
      setIsScraping(false);
      setIsScrapingLinkedPages(false);
      setAction(null);
      setLiveSessionId(null);
      setPollSessionId(null);
      setLiveProgress(null);
      setDownloadReport(initialDownloadReport);
      setDownloadResponse(null);
    };

    const finalizeAsComplete = () => {
      // Mirrors the DOWNLOAD_COMPLETE reset.
      setMessages((prev) => [
        ...prev,
        { key: "status.scraped" },
        { key: "status.creating" },
        { key: "status.complete" },
      ]);
      setAction(messageActions.DOWNLOAD_DONE);
      setLiveSessionId(null);
      setPollSessionId(null);
      setLiveProgress(null);
      setServerModeState((prev) => (prev ? { ...prev, phase: "ready" } : prev));
      setDownloadResponse(null);
      setIsScraping(false);
      setIsScrapingLinkedPages(false);
    };

    const stopTracking = () => {
      // The run settled without ever being observed live: it either surfaced
      // its own outcome via pushes already or aborted pre-session. Stop the
      // poll without faking a completion card.
      setPollSessionId(null);
      setLiveProgress(null);
    };

    const pollOnce = async () => {
      try {
        const snapshot: DownloadLiveSnapshot | null =
          await sendMessageToBackground(
            messageActions.CHECK_DOWNLOAD_LIVE,
            snapshotSessionId ? { sessionId: snapshotSessionId } : {},
          );
        if (cancelled || !snapshot) return;
        const decision = decideLivePollStep({
          snapshot,
          sawLive: sawLiveRef.current,
          downloadSettled: downloadSettledRef.current,
          confirmPending: confirmPendingRef.current,
        });
        switch (decision.action) {
          case "progress":
            sawLiveRef.current = true;
            confirmPendingRef.current = false;
            setLiveProgress(decision.snapshot);
            break;
          case "wait":
            // Download phase not observed yet — keep polling.
            break;
          case "armConfirm":
            confirmPendingRef.current = true;
            break;
          case "finalizeFailure":
            finalizeAsFailure(decision.error);
            break;
          case "finalizeComplete":
            finalizeAsComplete();
            break;
          case "stopTracking":
            stopTracking();
            break;
        }
      } catch {
        // Transient (background restarting) — the next tick retries.
      }
    };

    void pollOnce();
    const interval = setInterval(() => {
      void pollOnce();
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // The finalize callbacks close over state setters only; the hook's
    // setDownloadResponse wrapper is unstable, so it must stay out of the
    // dep array or the poll interval would be torn down on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessionId, isScraping, pollSessionId, t]);

  // Listen for download completion via chrome.storage
  useEffect(() => {
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName === "local" && changes.downloadComplete) {
        const downloadComplete = changes.downloadComplete.newValue;
        if (
          downloadComplete &&
          downloadComplete.tabId !== undefined &&
          downloadComplete.tabId === tabId
        ) {
          // Guard: skip if already handled via DOWNLOAD_COMPLETE message
          if (actionRef.current === messageActions.DOWNLOAD_DONE) {
            chrome.storage.local.remove("downloadComplete");
            return;
          }
          if (downloadComplete.downloadId) {
            chrome.storage.local.set({
              lastDownloadId: downloadComplete.downloadId,
            });
          }
          setMessages((prev) => [...prev, { key: "status.scraped" }]);
          setAction(messageActions.DOWNLOAD_DONE);
          setServerModeState((prev) =>
            prev ? { ...prev, phase: "ready" } : prev,
          );
          setMessages((prev) => [...prev, { key: "status.creating" }]);
          setMessages((prev) => [...prev, { key: "status.complete" }]);

          // Reset downloadResponse to allow filter to show again
          setDownloadResponse(null);

          // Stop scraping state to show completion UI
          setIsScraping(false);
          setIsScrapingLinkedPages(false);

          // Clear the downloadComplete flag
          chrome.storage.local.remove("downloadComplete");
        }
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);

    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [setMessages, setAction, setDownloadResponse, setIsScraping]);

  // Memoize reset function
  const reset = useCallback(
    (newTabUrl: string) => {
      setTabUrl(newTabUrl);
      setMessages([{ key: "status.waiting" }, { key: "status.connected" }]);
      setAction(null);
      setLinks([]);
      setIsScraping(false);
      setIsScrapingLinkedPages(false);
      setDownloadResponse(null); // Use setter from hook
      setScrollAttempts(0); // Use setter from hook
      setDownloadOptions(null);
      setServerModeState(initialServerModeState); // Reset server-mode state
      setCloudUploadState(null); // Reset cloud upload state
      setDownloadReport(initialDownloadReport); // (5.3) Reset download report
      // (Round 9 — Fix B) Stop any liveness poll from a finished run.
      setPollSessionId(null);
      setLiveProgress(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [setDownloadResponse, setScrollAttempts],
  ); // Add setters from hook to dependencies

  // Memoize onClickStartDownload
  const onClickStartDownload = useCallback(async (options: Options) => {
    setAction(null);
    setInterruptData(null);
    setCloudUploadState(null);
    setIsScraping(true);
    setDownloadOptions(options);
    setDownloadReport(initialDownloadReport); // (5.3) Fresh report per run
    setMessages((prev) => [...prev, { key: "status.scraping" }]);
    // (15.7) Track singleFile option in server-mode state
    setServerModeState((prev) => ({
      ...prev,
      phase: "scraping",
      isSingleFile: options.singleFile,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Keep dependencies minimal

  const resetError = useCallback(() => {
    setError(null);
    reset(tabUrl);
  }, [reset, tabUrl]);

  if (error) {
    return (
      <div className="p-6">
        <ErrorFallback error={error} resetErrorBoundary={resetError} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PagePocketAnnouncement />
      <MainContent
        messages={messages}
        tabId={tabId}
        isScraping={isScraping}
        isScrapingLinkedPages={isScrapingLinkedPages}
        action={action}
        downloadResponse={downloadResponse}
        onClickStartDownload={onClickStartDownload}
        tabUrl={tabUrl}
        // Don't interrupt a running download with the auth form
        showAuthForm={cloudStorageEnabled && !isAuthenticated && !isScraping}
        // (5.1) Hide the form on pages that cannot be downloaded
        tabSupported={tabSupported}
      />
      <DownloadStatus
        tabId={tabId}
        isScraping={isScraping}
        isScrapingLinkedPages={isScrapingLinkedPages}
        isPaused={isPaused}
        action={action}
        downloadResponse={downloadResponse}
        onStopScraping={stopScraping}
        setIsPaused={setIsPaused}
        serverModeState={serverModeState}
        onRetryServer={() => {
          // Re-trigger download with same options — reset all server
          // session refs so a fresh session is created on retry.
          if (downloadOptions) {
            setDownloadResponse(null);
            setScrollAttempts(0);
            setIsScraping(true);
            setMessages((prev) => [...prev, { key: "status.scraping" }]);
            setServerModeState((prev) => ({
              ...prev,
              phase: "scraping",
              serverError: null,
            }));
          }
        }}
        onDownloadFromServer={async () => {
          if (serverModeState.serverDownloadUrl) {
            const { loadFilterOptions } =
              await import("./common/storage/filterStorage");
            const opts = await loadFilterOptions();
            chrome.downloads.download({
              url: serverModeState.serverDownloadUrl,
              saveAs: opts.alwaysAskWhereToSave ?? true,
            });
          }
        }}
        // (5.2) Local fallback action — design D14: reuse the server ZIP URL
        // when one exists (fast path), otherwise trigger the server-side
        // assemble-and-redirect for the partially-uploaded session.
        onDownloadLocally={async () => {
          if (serverModeState.serverDownloadUrl) {
            const { loadFilterOptions } =
              await import("./common/storage/filterStorage");
            const opts = await loadFilterOptions();
            chrome.downloads.download({
              url: serverModeState.serverDownloadUrl,
              saveAs: opts.alwaysAskWhereToSave ?? true,
            });
            return;
          }
          try {
            await sendMessageToBackground(
              messageActions.SERVER_FINALIZE_SESSION,
              { tabId },
            );
            // Bounded poll until the assembled ZIP is ready.
            for (let attempt = 0; attempt < 60; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              const status = await sendMessageToBackground(
                messageActions.SERVER_SESSION_STATUS,
                { tabId },
              );
              const session = status?.result;
              if (session?.status === "ready" && session.download_url) {
                const { loadFilterOptions } =
                  await import("./common/storage/filterStorage");
                const opts = await loadFilterOptions();
                // Self-heal a same-host http:// scheme (TLS-terminating
                // proxy misconfig — see upgradeInsecureServerUrl), then
                // enforce transport security: this path bypasses the
                // background's triggerServerDownload validation (D11 /
                // task 7.4), and an unvalidated plain-http URL would
                // silently hit Chrome's mixed-content download block.
                const downloadUrl = upgradeInsecureServerUrl(
                  session.download_url,
                  serverClient.baseUrl,
                );
                assertSecureBaseUrl(downloadUrl, "Download URL");
                chrome.downloads.download({
                  url: downloadUrl,
                  saveAs: opts.alwaysAskWhereToSave ?? true,
                });
                return;
              }
              if (
                session?.status === "failed" ||
                session?.status === "expired"
              ) {
                return;
              }
            }
          } catch {
            // Assemble-and-redirect unavailable — the failure card stays.
          }
        }}
        interruptData={interruptData}
        // (Fix D.1) A live download shows "in progress" instead of the
        // Resume/Restart card.
        liveDownload={liveSessionId !== null}
        // (Round 9 — Fix B) Trusted progress from the liveness poll.
        liveProgress={liveProgress}
        onRestartDownload={async () => {
          setInterruptData(null);
          // If we have a server session ID, attempt resume
          if (interruptData?.serverSessionId) {
            setIsScraping(true);
            setMessages((prev) => [
              ...prev,
              { key: "status.reconnectingServer" },
            ]);
            setServerModeState((prev) => ({
              ...prev,
              phase: "uploading",
              serverError: null,
            }));
            try {
              const result = await sendMessageToBackground(
                messageActions.RESUME_SERVER_DOWNLOAD,
                {
                  serverSessionId: interruptData.serverSessionId,
                  tabUrl: interruptData.tabUrl,
                  phase: interruptData.phase,
                  resourceUrls: interruptData.resourceUrls,
                },
              );
              if (result?.fallback) {
                // Resume failed — fall through to full restart
                throw new Error(result.error || "Resume failed");
              }
              // Resume succeeded — update state
              setIsScraping(false);
              setAction(messageActions.DOWNLOAD_DONE);
            } catch {
              // Resume failed — fall back to full restart
              if (downloadOptions) {
                setIsScraping(true);
                setDownloadOptions(downloadOptions);
                setMessages((prev) => [...prev, { key: "status.scraping" }]);
                setServerModeState((prev) => ({
                  ...prev,
                  phase: "scraping",
                  serverError: null,
                }));
              }
            }
          } else if (downloadOptions) {
            setIsScraping(true);
            setDownloadOptions(downloadOptions);
            setMessages((prev) => [...prev, { key: "status.scraping" }]);
            setServerModeState((prev) => ({
              ...prev,
              phase: "scraping",
              serverError: null,
            }));
          }
        }}
        onDismissInterrupt={() => {
          setInterruptData(null);
          setMessages([{ key: "status.connected" }]);
          // (Fix D.2 — dismiss scoping) Clear ONLY this session's checkpoint
          // so re-opening the panel doesn't show stale state. A checkpoint
          // without a session id requires the explicit all-flag; concurrent
          // downloads' checkpoints must never be wiped by one card's dismiss.
          sendMessageToBackground(
            messageActions.DISMISS_INTERRUPTED_DOWNLOAD,
            interruptData?.serverSessionId
              ? { serverSessionId: interruptData.serverSessionId }
              : { all: true },
          );
        }}
        cloudUploadState={cloudUploadState}
        onRetryCloudUpload={() => {
          if (downloadOptions) {
            setCloudUploadState(null);
            setIsScraping(true);
            setMessages((prev) => [...prev, { key: "status.scraping" }]);
          }
        }}
      />
      <DownloadComplete
        tabId={tabId}
        tabUrl={tabUrl}
        links={links}
        action={action}
        reset={reset}
        serverDownloadUrl={serverModeState.serverDownloadUrl}
        isSingleFile={serverModeState.isSingleFile}
        serverSessionId={serverModeState.serverSessionId}
        cloudUploadState={cloudUploadState}
        downloadReport={downloadReport}
        failedUploads={serverModeState.failedUploads}
      />
    </div>
  );
}

// mergeDownloadResponse function removed (moved to utils)

const root = createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>,
);

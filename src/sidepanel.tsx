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
import { decideLivePollStep } from "./sidepanel/utils/livePolling";
import {
  classifyDownloadMessage,
  classifyTerminalRecord,
  messageClassForPanelKey,
  type DownloadIdentity,
} from "./sidepanel/utils/downloadRouting";
import {
  shouldArmWatchdog,
  shouldResetWatchdog,
  shouldWatchdogFire,
} from "./sidepanel/utils/downloadWatchdog";
import { useDownloadWatchdog } from "./sidepanel/hooks/useDownloadWatchdog";
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

  // (Fix 1 — D1) Pinned download identity: { originTabId, serverSessionId }
  // captured when a download flow starts. messageWorker and the
  // chrome.storage fallback route EVERY message against this identity —
  // never against the live focused tab (useActiveTabInfo re-pins that on
  // every tabs.onActivated, which used to drop progress and terminal pushes
  // alike the moment the user switched tabs).
  const downloadIdentityRef = useRef<DownloadIdentity>({
    originTabId: 0,
    serverSessionId: null,
  });
  // (Fix 1 + 5.3) Terminal-already-resolved marker: set by the terminal
  // appliers when a live message resolved the tracked download; the
  // chrome.storage fallback records (downloadCancelled / downloadFailed)
  // skip their UI updates when it is set — the same dedup idea as
  // downloadComplete's actionRef check.
  const resolvedTerminalRef = useRef<string | null>(null);
  // (Fix 1 — D1) Render-time mirror of the press-time pinned download tab
  // (useScrapingDownloader's targetRef) — the authoritative originTabId
  // once the run's effects have pinned it.
  const pinnedDownloadTabRef = useRef<number>(0);
  // (Fix 1 — D1) Render-time mirror of the live tab (actionRef pattern) —
  // read at click time by the identity pin; equals the value the hook's
  // Effect 1 snapshots for the same press.
  const liveTabIdRef = useRef<number>(0);
  liveTabIdRef.current = tabId;
  // (Fix 1 — D1) The single identity update point. Called at press time
  // (onClickStartDownload), when a run reaches its download phase
  // (onDownloadStarted), when a reopened panel adopts a live download, and
  // by the resume/restart paths.
  const pinDownloadIdentity = useCallback((identity: DownloadIdentity) => {
    downloadIdentityRef.current = identity;
  }, []);

  // (Fix 2 — 2.3) Render-time mirror of downloadOptions — read by the
  // DOWNLOAD_INTERRUPTED applier at message time (the handler closes over
  // refs, not render state).
  const downloadOptionsRef = useRef(downloadOptions);
  downloadOptionsRef.current = downloadOptions;
  // (Fix 2 — D2) Options snapshot captured by the DOWNLOAD_INTERRUPTED
  // applier BEFORE it clears downloadOptions. The resume-failure fallback
  // ("full restart") re-reads its restart options here — the design risk
  // note's "re-reads the options it needs before clearing" — while the
  // cleared state can no longer re-arm Effect 2's auto-START_DOWNLOAD after
  // an interrupt.
  const interruptedOptionsRef = useRef<Options | null>(null);

  // Initialize useScrapingDownloader hook early so setDownloadResponse is available
  const {
    downloadResponse,
    setDownloadResponse,
    setScrollAttempts,
    stopScraping,
    getPinnedTabId,
    getServerSessionId,
    // (Fix 2 — D2) Resume single-fire gate — the resume flow never scrapes.
    beginResume,
    endResume,
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
      // (Fix 1 — D1) The download phase begins: pin THIS run's identity —
      // origin tab from the hook's Fix A press-time snapshot (now
      // authoritative), session id from the created/resumed session. This
      // is the identity update point every flow that reaches a download
      // phase passes through.
      pinDownloadIdentity({
        originTabId: pinnedDownloadTabRef.current || liveTabIdRef.current,
        serverSessionId,
      });
      resolvedTerminalRef.current = null;
    },
    // (Round 9 — Fix B) The START_DOWNLOAD promise settled — the run is
    // terminal-eligible even if no poll observed the session live.
    onDownloadSettled: () => {
      downloadSettledRef.current = true;
    },
  });

  // (Round 9 — Fix 3/4) Mirror the hook's press-time snapshot + session id
  // into refs every render, so the identity pin and the poll loop always
  // read the CURRENT values without re-subscribing the message listener.
  pinnedDownloadTabRef.current = getPinnedTabId();
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = getServerSessionId();

  // -----------------------------------------------------------------------
  // (Fix 1 + 5.3) Terminal state appliers — the DOWNLOAD_COMPLETE /
  // DOWNLOAD_FAILED / DOWNLOAD_CANCELLED handler bodies, extracted so the
  // chrome.storage fallback records resolve the UI to EXACTLY the same
  // state as the live messages (same sets, same order). Each applier also
  // marks the tracked download as terminal-resolved so the storage
  // consumer can skip an already-handled outcome.
  // -----------------------------------------------------------------------
  const applyDownloadCompleteState = useCallback(
    (data: { downloadId?: number }) => {
      resolvedTerminalRef.current = "complete";
      // Download actually completed - file was saved
      setMessages((prev) => [...prev, { key: "status.scraped" }]);
      setAction(messageActions.DOWNLOAD_DONE);
      // (Fix D.1) The download is no longer live.
      setLiveSessionId(null);
      // (Round 9) Stop the liveness poll — terminal via push.
      setPollSessionId(null);
      setServerModeState((prev) => (prev ? { ...prev, phase: "ready" } : prev));
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
    },
    [setDownloadResponse],
  );

  const applyDownloadFailedState = useCallback(
    (data: { error?: string }) => {
      resolvedTerminalRef.current = "failed";
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
    },
    [t, setDownloadResponse],
  );

  const applyDownloadCancelledState = useCallback(() => {
    resolvedTerminalRef.current = "cancelled";
    // (5.5) Full cancel — show explicit feedback instead of silently
    // resetting to the connected state.
    setMessages([{ key: "status.connected" }, { key: "status.cancelled" }]);
    setIsScraping(false);
    setIsScrapingLinkedPages(false);
    setAction(null);
    // (Fix D.1) The download is no longer live.
    setLiveSessionId(null);
    // (Round 9) Stop the liveness poll — terminal via push.
    setPollSessionId(null);
    setDownloadReport(initialDownloadReport);
    setDownloadResponse(null);
  }, [setDownloadResponse]);

  // (Fix 3 — 3.2) The DOWNLOAD_INTERRUPTED handler body, extracted so the
  // dead-worker watchdog (D3) transitions the panel to byte-for-byte the
  // same interrupted card as the background's push (same sets, same order).
  const applyDownloadInterruptedState = useCallback(
    (data: {
      phase?: string;
      tabUrl?: string;
      timestamp?: number;
      tabId?: number;
      serverSessionId?: string;
      resourceUrls?: InterruptData["resourceUrls"];
    }) => {
      // (Fix 2 — 2.3) Capture the options BEFORE clearing them (the resume
      // fallback re-reads the snapshot), so a stale options object cannot
      // re-arm the auto-START_DOWNLOAD effect after an interrupt.
      interruptedOptionsRef.current = downloadOptionsRef.current;
      setDownloadOptions(null);
      // Service worker was killed during an active download
      setInterruptData({
        phase: data.phase || "scraping",
        tabUrl: data.tabUrl || "",
        timestamp: data.timestamp || Date.now(),
        // (Fix 1 — D1) Keep the checkpoint's origin tab so the resume
        // path can pin the download identity to it.
        tabId: data.tabId,
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
    },
    [setDownloadResponse],
  );

  // -----------------------------------------------------------------------
  // (Fix 3 — D3) Dead-worker watchdog. Armed while a download is tracked
  // and the server-mode phase is uploading/assembling — the phases where
  // the panel is a passive receiver of background pushes and a killed MV3
  // worker used to freeze the spinner forever. `resetWatchdog` is called
  // from the message-routing application path (routeAndReset below and the
  // storage consumer) so ANY message belonging to the tracked download
  // restarts the 45 s window (3 missed 15 s heartbeats). On timeout the
  // panel shows the SAME interrupted card as DOWNLOAD_INTERRUPTED.
  // -----------------------------------------------------------------------
  const watchdogArmed = shouldArmWatchdog({
    phase: serverModeState.phase,
    downloadTracked:
      // A download is tracked: the reopened live session, the press-run's
      // poll target, an active scrape, or a resume — and no terminal state
      // has resolved it (the appliers set resolvedTerminalRef; that also
      // disarms on any terminal outcome).
      (liveSessionId !== null ||
        pollSessionId !== null ||
        isScraping ||
        downloadIdentityRef.current.serverSessionId !== null) &&
      resolvedTerminalRef.current === null,
  });
  const { reset: resetWatchdog } = useDownloadWatchdog({
    armed: watchdogArmed,
    onTimeout: () => {
      // (D3) A terminal message that arrived for the tracked download
      // always wins over a concurrently expiring watchdog.
      if (
        !shouldWatchdogFire({
          armed: true,
          terminalResolved: resolvedTerminalRef.current !== null,
        })
      ) {
        return;
      }
      const identity = downloadIdentityRef.current;
      applyDownloadInterruptedState({
        // Phase from the current server-mode state (uploading/assembling —
        // the only phases that can arm the watchdog).
        phase: serverModeState.phase || "scraping",
        tabId: identity.originTabId || undefined,
        serverSessionId:
          identity.serverSessionId ??
          liveSessionId ??
          pollSessionId ??
          undefined,
      });
    },
  });

  // Memoize messageWorker to stabilize useMessageListener dependency
  const messageWorker = useCallback(
    async (action: MessageAction, data: any): Promise<any> => {
      // (Fix 3 — D3) Central watchdog reset: every message the routing
      // accepts FOR the tracked download (progress push, 15 s heartbeat,
      // assembly progress, terminal) restarts the silence window.
      // Cross-download traffic must not keep a dead worker alive.
      const routeAndReset = (
        msg: { tabId?: number; serverSessionId?: string | null },
        messageClass: "progress" | "terminal",
      ) => {
        const decision = classifyDownloadMessage(
          downloadIdentityRef.current,
          msg,
          messageClass,
        );
        if (shouldResetWatchdog(decision)) resetWatchdog();
        return decision;
      };
      switch (action) {
        case messageActions.PANEL_PING:
          // Service worker is checking if we're alive
          return "PONG";

        case messageActions.PANEL_MESSAGE:
          // (Fix 1 — D1) Route by download identity, not the live focused
          // tab. Progress-class keys apply only on identity match;
          // terminal-class keys are always evaluated and resolve the UI
          // when they belong to the tracked download — even after a tab
          // switch, or when they arrive unscoped (resume-path pushes).
          // Cross-download progress stays filtered.
          const panelRouting = routeAndReset(
            {
              tabId: data.tabId,
              serverSessionId: data.message?.options?.serverSessionId,
            },
            messageClassForPanelKey(data.message?.key),
          );
          if (panelRouting === "ignore" || panelRouting === "terminal-ignore") {
            break;
          }
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
          // (Fix 1 — D1) Progress-class: identity match only.
          if (routeAndReset({ tabId: data.tabId }, "progress") === "ignore")
            break;
          setCloudUploadState({ status: "uploading", progress: 0 });
          break;

        case messageActions.PAGEPOCKET_UPLOAD_PROGRESS:
          // (Fix 1 — D1) Progress-class: identity match only.
          if (routeAndReset({ tabId: data.tabId }, "progress") === "ignore")
            break;
          setCloudUploadState((prev) =>
            prev ? { ...prev, progress: data.progress ?? prev.progress } : prev,
          );
          break;

        case messageActions.PAGEPOCKET_UPLOAD_COMPLETE:
          // (Fix 1 — D1) Terminal: always evaluated; resolves the UI when
          // it belongs to the tracked download.
          if (
            routeAndReset({ tabId: data.tabId }, "terminal") ===
            "terminal-ignore"
          )
            break;
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
          // (Fix 1 — D1) Terminal: always evaluated; resolves the UI when
          // it belongs to the tracked download.
          if (
            routeAndReset({ tabId: data.tabId }, "terminal") ===
            "terminal-ignore"
          )
            break;
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
          // (Fix 1 — D1) Terminal: always evaluated — the old live-tab
          // filter dropped it exactly when the user had switched away from
          // the download's tab, leaving the spinner up forever.
          if (
            routeAndReset({ tabId: data.tabId }, "terminal") ===
            "terminal-ignore"
          )
            break;
          applyDownloadCompleteState(data);
          break;

        case messageActions.DOWNLOAD_FAILED:
          // (Fix 1 — D1) Terminal: always evaluated; see DOWNLOAD_COMPLETE.
          if (
            routeAndReset({ tabId: data.tabId }, "terminal") ===
            "terminal-ignore"
          )
            break;
          applyDownloadFailedState(data);
          break;

        case messageActions.DOWNLOAD_CANCELLED:
          // (Fix 1 — D1) Terminal: always evaluated; see DOWNLOAD_COMPLETE.
          if (
            routeAndReset({ tabId: data.tabId }, "terminal") ===
            "terminal-ignore"
          )
            break;
          applyDownloadCancelledState();
          break;

        case messageActions.DOWNLOAD_INTERRUPTED:
          // (Fix 1 — D1) Terminal: always evaluated. Unscoped interrupt
          // pushes (startup cleanup) and interrupts for the tracked
          // download resolve the UI; an interrupt that provably belongs to
          // a different download must not clobber a live card.
          if (
            routeAndReset(
              {
                tabId: data.tabId,
                serverSessionId: data.serverSessionId,
              },
              "terminal",
            ) === "terminal-ignore"
          )
            break;
          // Service worker was killed during an active download — the
          // extracted applier is byte-identical to the pre-extraction
          // handler body AND to the watchdog's timeout transition (3.2).
          applyDownloadInterruptedState(data);
          break;

        default:
          break;
      }
      return null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      setDownloadResponse,
      applyDownloadCompleteState,
      applyDownloadFailedState,
      applyDownloadCancelledState,
      applyDownloadInterruptedState,
      resetWatchdog,
    ],
  ); // Add setDownloadResponse + terminal appliers + watchdog reset to dependencies

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
                // (Fix 1 — D1) Adopt the reopened live download by identity:
                // origin tab + session from the checkpoint, so its pushes
                // (stamped with the origin tab) and terminal outcomes route
                // to this panel even though it never pressed Start here.
                pinDownloadIdentity({
                  originTabId: result.tabId ?? 0,
                  serverSessionId: result.serverSessionId ?? null,
                });
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
            // (Fix 1 — D1) Keep the checkpoint's origin tab so the resume
            // path can pin the download identity to it.
            tabId: result.tabId,
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

  // Listen for terminal download states via chrome.storage (design D4).
  // COMPLETE keeps its existing fallback record; CANCELLED and FAILED gain
  // the same treatment (task 5.3). Records are routed by the PINNED
  // download identity — never the live tab, whose stale-closure comparison
  // used to drop the completion after a tab switch — applied exactly once,
  // and removed after consumption. The UI state each record resolves to is
  // the shared terminal appliers, i.e. byte-for-byte the live message
  // handlers' outcome.
  useEffect(() => {
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== "local") return;

      if (changes.downloadComplete) {
        const record = changes.downloadComplete.newValue;
        if (
          record &&
          classifyTerminalRecord(downloadIdentityRef.current, record) !==
            "terminal-ignore"
        ) {
          // (Fix 3 — D3) A record belonging to the tracked download is
          // liveness traffic too.
          resetWatchdog();
          // Guard: skip if already handled via DOWNLOAD_COMPLETE message
          if (actionRef.current === messageActions.DOWNLOAD_DONE) {
            chrome.storage.local.remove("downloadComplete");
          } else {
            applyDownloadCompleteState(record);
            // Clear the downloadComplete flag
            chrome.storage.local.remove("downloadComplete");
          }
        }
      }

      if (changes.downloadCancelled) {
        const record = changes.downloadCancelled.newValue;
        if (
          record &&
          classifyTerminalRecord(downloadIdentityRef.current, record) !==
            "terminal-ignore"
        ) {
          resetWatchdog();
          // Guard: skip when a live terminal message already resolved the
          // tracked download (same dedup pattern as downloadComplete).
          if (resolvedTerminalRef.current !== null) {
            chrome.storage.local.remove("downloadCancelled");
          } else {
            // Same UI state as the DOWNLOAD_CANCELLED handler.
            applyDownloadCancelledState();
            chrome.storage.local.remove("downloadCancelled");
          }
        }
      }

      if (changes.downloadFailed) {
        const record = changes.downloadFailed.newValue;
        if (
          record &&
          classifyTerminalRecord(downloadIdentityRef.current, record) !==
            "terminal-ignore"
        ) {
          resetWatchdog();
          // Guard: skip when a live terminal message already resolved the
          // tracked download (same dedup pattern as downloadComplete).
          if (resolvedTerminalRef.current !== null) {
            chrome.storage.local.remove("downloadFailed");
          } else {
            // Same UI state as the DOWNLOAD_FAILED handler.
            applyDownloadFailedState(record);
            chrome.storage.local.remove("downloadFailed");
          }
        }
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);

    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [
    applyDownloadCompleteState,
    applyDownloadCancelledState,
    applyDownloadFailedState,
    resetWatchdog,
  ]);

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
      // (Fix 2 — 2.3) A new tab context supersedes any interrupted run's
      // options snapshot.
      interruptedOptionsRef.current = null;
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
    // (Fix 1 — D1) Pin the download identity at press time. The origin tab
    // is the same press-time snapshot useScrapingDownloader's Effect 1 pins
    // for this run (both read the same render's tabId); the server session
    // id is pinned later, once created/resumed (onDownloadStarted).
    downloadIdentityRef.current = {
      originTabId: liveTabIdRef.current,
      serverSessionId: null,
    };
    resolvedTerminalRef.current = null;
    // (Fix 2 — 2.3) A fresh press carries its own options — drop any
    // interrupted run's snapshot.
    interruptedOptionsRef.current = null;
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
        // (Fix 1 — D1) Controls (Pause/Resume — and Stop via the hook's
        // pinned targetRef) act on the download's OWN tab, not the
        // currently focused one. 0 = nothing pinned → component falls
        // back to the live tab.
        downloadOriginTabId={
          downloadIdentityRef.current.originTabId || undefined
        }
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
            // (Fix 2 — D2) Resume NEVER scrapes: no setIsScraping(true), so
            // Effect 1 never arms scrape() — no new server session, no
            // scrolling. beginResume() owns the single-fire gate: a rapid
            // double-click sends at most one RESUME_SERVER_DOWNLOAD, and
            // Effect 2 can never fire a START_DOWNLOAD for the resume run.
            if (!beginResume()) return;
            // (Fix 1 — D1) The resume continues the interrupted run's
            // session — pin its identity (origin tab from the checkpoint,
            // falling back to the current view) so resume-path pushes
            // (unscoped) and origin-tab-stamped terminals route here.
            pinDownloadIdentity({
              originTabId: interruptData.tabId ?? liveTabIdRef.current,
              serverSessionId: interruptData.serverSessionId,
            });
            resolvedTerminalRef.current = null;
            setMessages((prev) => [
              ...prev,
              { key: "status.reconnectingServer" },
            ]);
            // Uploading phase: the resumed download streams resources like a
            // fresh one — progress pushes arrive via the identity routing
            // (Fix 1) and the watchdog (Fix 3) covers a dead worker.
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
              // (Fix 2 — D2) Dedicated resume status: the session is live
              // again — the live-download card plus the CHECK_DOWNLOAD_LIVE
              // poll track it until a terminal push resolves the run (the
              // old code flipped DOWNLOAD_DONE here, blanking the status
              // mid-download).
              sawLiveRef.current = false;
              downloadSettledRef.current = false;
              confirmPendingRef.current = false;
              setLiveSessionId(interruptData.serverSessionId);
              setPollSessionId(interruptData.serverSessionId);
              endResume();
            } catch {
              endResume();
              // Resume failed — fall back to a full restart: the ONLY path
              // from the resume flow into the scrape pipeline. It goes
              // through the normal single-run gate (the isScraping
              // false→true transition re-arms Effect 1's Fix A gate for
              // exactly one scrape run).
              // (Fix 2 — 2.3) downloadOptions was cleared by the interrupt
              // applier — re-read the snapshot captured before the clear.
              const restartOptions =
                downloadOptions ?? interruptedOptionsRef.current;
              if (restartOptions) {
                interruptedOptionsRef.current = null;
                // (Fix 1 — D1) The restart scrape creates a NEW session on
                // the current tab — re-pin the identity for it
                // (onDownloadStarted refines the session id).
                pinDownloadIdentity({
                  originTabId: liveTabIdRef.current,
                  serverSessionId: null,
                });
                resolvedTerminalRef.current = null;
                setIsScraping(true);
                setDownloadOptions(restartOptions);
                setMessages((prev) => [...prev, { key: "status.scraping" }]);
                setServerModeState((prev) => ({
                  ...prev,
                  phase: "scraping",
                  serverError: null,
                }));
              }
            }
          } else {
            // (Fix 1 — D1) Full restart without a session — same re-pin and
            // the same single-run gate (and the same 2.3 options re-read).
            const restartOptions =
              downloadOptions ?? interruptedOptionsRef.current;
            if (restartOptions) {
              interruptedOptionsRef.current = null;
              pinDownloadIdentity({
                originTabId: liveTabIdRef.current,
                serverSessionId: null,
              });
              resolvedTerminalRef.current = null;
              setIsScraping(true);
              setDownloadOptions(restartOptions);
              setMessages((prev) => [...prev, { key: "status.scraping" }]);
              setServerModeState((prev) => ({
                ...prev,
                phase: "scraping",
                serverError: null,
              }));
            }
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

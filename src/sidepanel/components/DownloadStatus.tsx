import { Button } from "../../components/Button";
import { MessageAction, messageActions } from "../../common/message";
import { ScrollingResponse } from "../hooks/useScrapingDownloader";
import { useTranslation } from "react-i18next";
import { sendMessage } from "../../common/chrome";
import {
  Upload,
  Server,
  AlertTriangle,
  RefreshCw,
  Download,
  Loader2,
  Clock,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Server-mode UI state (tasks 15.1–15.7)
// Type imported from shared module to avoid duplication.
// ---------------------------------------------------------------------------

export type { ServerModeState } from "../server-mode-state";
import { ServerModeState } from "../server-mode-state";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DownloadStatusProps {
  tabId: number;
  isScraping: boolean;
  isScrapingLinkedPages: boolean;
  isPaused: boolean;
  action: MessageAction | null;
  downloadResponse: ScrollingResponse | null;
  setIsScraping: (value: boolean) => void;
  setIsPaused: (value: boolean) => void;
  /** (15.1–15.7) Server-mode state; only passed when IS_SERVER_MODE is true. */
  serverModeState?: ServerModeState;
  /** (15.5) Retry the server download. */
  onRetryServer?: () => void;
  /** (15.5) Fall back to local download mode. */
  onLocalFallback?: () => void;
  /** (15.3) Trigger download from server when ZIP is ready. */
  onDownloadFromServer?: () => void;
}

// ---------------------------------------------------------------------------
// Shared scraping control buttons
// ---------------------------------------------------------------------------

function ScrapingControls({
  isPaused,
  setIsPaused,
  setIsScraping,
}: {
  isPaused: boolean;
  setIsPaused: (value: boolean) => void;
  setIsScraping: (value: boolean) => void;
}) {
  const { t } = useTranslation();

  const handlePause = async () => {
    setIsPaused(true);
    await sendMessage("background", { action: messageActions.SCRAPER_PAUSE, data: {} });
  };

  const handleResume = async () => {
    setIsPaused(false);
    await sendMessage("background", { action: messageActions.SCRAPER_RESUME, data: {} });
  };

  const handleStop = async () => {
    await sendMessage("background", { action: messageActions.SCRAPER_STOP, data: {} });
    setIsScraping(false);
  };

  return (
    <div className="flex gap-2">
      {isPaused ? (
        <Button onClick={handleResume} variant={"secondary"}>
          {t('actions.resume')}
        </Button>
      ) : (
        <Button onClick={handlePause} variant={"secondary"}>
          {t('actions.pause')}
        </Button>
      )}
      <Button onClick={handleStop} variant={"secondary"}>
        {t('actions.stop')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DownloadStatus({
  tabId,
  isScraping,
  isScrapingLinkedPages,
  isPaused,
  action,
  downloadResponse,
  setIsScraping,
  setIsPaused,
  serverModeState,
  onRetryServer,
  onLocalFallback,
  onDownloadFromServer,
}: DownloadStatusProps) {
  const { t } = useTranslation();

  if (!tabId) return null;

  // -----------------------------------------------------------------------
  // (15.5 + 15.6) Server error / timeout display
  // -----------------------------------------------------------------------
  if (serverModeState && (serverModeState.phase === 'failed' || serverModeState.phase === 'timeout')) {
    const serverError = serverModeState.serverError;
    const isTimeout = serverModeState.phase === 'timeout';
    const reasonLabel = isTimeout
      ? t('status.assemblyTimeout')
      : serverError?.reason === 'server_unavailable'
        ? t('status.serverUnavailable')
        : serverError?.reason === 'assembly_failed'
          ? t('status.assemblyFailed')
          : serverError?.reason === 'auth_failed'
            ? t('status.authFailed')
            : t('status.serverError', { error: serverError?.error ?? '' });

    return (
      <div className="pt-8 animate-fade-in">
        <div className="card p-6 bg-gradient-to-b from-red-50 to-white border-red-200 space-y-4">
          <div className="flex items-center gap-3">
            {isTimeout ? (
              <Clock className="w-8 h-8 text-amber-500 flex-shrink-0" />
            ) : (
              <AlertTriangle className="w-8 h-8 text-red-500 flex-shrink-0" />
            )}
            <div>
              <h3 className="font-bold text-slate-800">
                {isTimeout ? t('status.assemblyTimeout') : t('status.failed')}
              </h3>
              <p className="text-sm text-slate-600 mt-1">{reasonLabel}</p>
            </div>
          </div>

          {/* Assembly timeout details */}
          {isTimeout && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              {t('status.assemblyTimeout')}
            </p>
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-2">
            {onRetryServer && (
              <button
                onClick={onRetryServer}
                className="btn-primary w-full flex items-center justify-center gap-2 cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                {t('status.retryServer')}
              </button>
            )}
            {serverError?.canFallback && onLocalFallback && (
              <button
                onClick={onLocalFallback}
                className="btn-secondary w-full flex items-center justify-center gap-2 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                {t('status.downloadLocally')}
              </button>
            )}
          </div>

          {/* Re-scrape warning for local fallback */}
          {serverError?.canFallback && (
            <p className="text-xs text-amber-600 bg-amber-50/50 border border-amber-100 rounded p-2">
              {t('status.localFallbackWarning')}
            </p>
          )}
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // (15.3) "Download from server" button when ZIP is ready
  // -----------------------------------------------------------------------
  if (serverModeState && serverModeState.phase === 'ready' && serverModeState.serverDownloadUrl && onDownloadFromServer) {
    return (
      <div className="pt-8 animate-fade-in">
        <div className="card p-6 bg-gradient-to-b from-green-50 to-white border-green-200 space-y-4">
          <div className="flex items-center gap-3">
            <Server className="w-8 h-8 text-green-500 flex-shrink-0" />
            <div>
              <h3 className="font-bold text-slate-800">{t('status.complete')}</h3>
              <p className="text-sm text-slate-500">{t('status.assemblingServer')}</p>
            </div>
          </div>
          <button
            onClick={onDownloadFromServer}
            className="btn-primary w-full flex items-center justify-center gap-2 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            {t('status.downloadFromServer')}
          </button>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // (15.2) Server assembly status display
  // -----------------------------------------------------------------------
  if (serverModeState && serverModeState.phase === 'assembling') {
    const phaseLabel = serverModeState.assemblyPhase
      ? t(`status.assemblyPhase${capitalizePhase(serverModeState.assemblyPhase)}`, serverModeState.assemblyPhase)
      : '';
    const progressPct = serverModeState.assemblyProgressPct ?? 0;

    return (
      <div className="pt-8 animate-fade-in">
        <div className="card p-6 bg-white space-y-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
            </div>
            <div>
              <h3 className="font-bold text-slate-800">{t('status.assemblingServer')}</h3>
              {phaseLabel && (
                <p className="text-sm text-slate-500">{phaseLabel}</p>
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-slate-100 rounded-full h-2.5">
            <div
              className="bg-indigo-500 h-2.5 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(progressPct, 100)}%` }}
            />
          </div>
          {progressPct > 0 && (
            <p className="text-xs text-slate-500 text-center">
              {Math.round(progressPct)}%
            </p>
          )}

          {/* Stop button */}
          <ScrapingControls isPaused={isPaused} setIsPaused={setIsPaused} setIsScraping={setIsScraping} />
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // (15.1 + 15.7) Uploading status with progress
  // -----------------------------------------------------------------------
  if (serverModeState && serverModeState.phase === 'uploading') {
    const { uploadCompleted, uploadTotal } = serverModeState;
    const progressPct = uploadTotal > 0 ? (uploadCompleted / uploadTotal) * 100 : 0;

    return (
      <div className="pt-8 animate-fade-in">
        <div className="card p-6 bg-white space-y-4">
          <div className="flex items-center gap-3">
            <Upload className="w-8 h-8 text-indigo-500" />
            <div>
              <h3 className="font-bold text-slate-800">{t('status.uploadingResources')}</h3>
              {uploadTotal > 0 && (
                <p className="text-sm text-slate-500">
                  {t('status.uploadProgress', { completed: uploadCompleted, total: uploadTotal })}
                </p>
              )}
            </div>
          </div>

          {/* Upload progress bar */}
          {uploadTotal > 0 && (
            <div className="w-full bg-slate-100 rounded-full h-2.5">
              <div
                className="bg-indigo-500 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(progressPct, 100)}%` }}
              />
            </div>
          )}

          {/* Stop button */}
          <ScrapingControls isPaused={isPaused} setIsPaused={setIsPaused} setIsScraping={setIsScraping} />
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // (15.7) Scraping status with server-mode indicator
  // -----------------------------------------------------------------------
  // Show buttons during any scraping activity (main page or linked pages)
  if (isScraping || isScrapingLinkedPages) {
    return (
      <div className="pt-8">
        <h3 className="pb-2 font-bold">{t('status.scraping')}</h3>
        <ScrapingControls isPaused={isPaused} setIsPaused={setIsPaused} setIsScraping={setIsScraping} />
      </div>
    );
  }

  // Show progress when download is in progress but not actively scraping
  // and not in a server-mode phase (uploading/assembling/ready handled above).
  // Hide this component when download is complete (DOWNLOAD_DONE)
  if (
    !isScraping &&
    !isScrapingLinkedPages &&
    action !== messageActions.DOWNLOAD_DONE &&
    !!downloadResponse
  ) {
    return (
      <div className="pt-8">
        <h3 className="pb-2 font-bold">{t('status.downloadingWebsiteContent')}</h3>
        <ScrapingControls isPaused={isPaused} setIsPaused={setIsPaused} setIsScraping={setIsScraping} />
      </div>
    );
  }

  // Hide component when download is complete
  if (action === messageActions.DOWNLOAD_DONE) {
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capitalize the first letter of an assembly phase for i18n key lookup.
 * e.g. "merging" → "Merging", "converting" → "Converting"
 */
function capitalizePhase(phase: string): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

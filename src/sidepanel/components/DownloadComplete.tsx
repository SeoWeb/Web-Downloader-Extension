import React, { useEffect, useState } from "react";
import { MessageAction, messageActions } from "../../common/message";
import { useTranslation } from "react-i18next";
import { CheckCircle, FolderOpen, RefreshCcw, Info, ChevronDown, Copy, Check, Server, FileText } from "lucide-react";

const ChromeExtensionRating = React.lazy(
  () => import("../../components/ChromeExtensionRating"),
);

interface DownloadCompleteProps {
  tabId: number;
  tabUrl: string;
  links: string[];
  action: MessageAction | null;
  reset: (newTabUrl: string) => void;
  /** (15.4) Server download URL to display with copy button. */
  serverDownloadUrl?: string | null;
  /** (15.4) Whether the download is a single-file HTML (affects filename display). */
  isSingleFile?: boolean;
}

export function DownloadComplete({
  tabUrl,
  action,
  reset,
  serverDownloadUrl,
  isSingleFile,
}: DownloadCompleteProps) {
  const { t } = useTranslation();
  const [downloadId, setDownloadId] = useState<number | null>(null);
  const [isAlertExpanded, setIsAlertExpanded] = useState<boolean>(true);
  const [urlCopied, setUrlCopied] = useState<boolean>(false);

  // Load alert preference from Chrome storage
  useEffect(() => {
    chrome.storage.local.get("hideExtractionAlert", (result) => {
      if (result.hideExtractionAlert === true) {
        setIsAlertExpanded(false);
      }
    });
  }, []);

  useEffect(() => {
    if (action === messageActions.DOWNLOAD_DONE) {
      chrome.storage.local.get("lastDownloadId", (result) => {
        if (result.lastDownloadId) {
          setDownloadId(result.lastDownloadId);
        }
      });
    }
  }, [action]);

  const handleShowInFolder = () => {
    if (downloadId) {
      chrome.downloads.show(downloadId);
    }
  };

  const handleReset = () => {
    reset(tabUrl);
  };

  const handleCopyUrl = async () => {
    if (serverDownloadUrl) {
      try {
        await navigator.clipboard.writeText(serverDownloadUrl);
        setUrlCopied(true);
        setTimeout(() => setUrlCopied(false), 2000);
      } catch {
        // Clipboard API may not be available in all contexts
      }
    }
  };

  const handleToggleAlert = () => {
    setIsAlertExpanded(!isAlertExpanded);
  };

  const handleHideNextTime = () => {
    chrome.storage.local.set({ hideExtractionAlert: true }, () => {
      setIsAlertExpanded(false);
    });
  };

  if (action !== messageActions.DOWNLOAD_DONE) {
    return null;
  }

  return (
    <div className="pt-8 animate-scale-in">
      <div className="card p-8 bg-gradient-to-b from-green-50 to-white border-green-100 flex flex-col items-center text-center space-y-6">

        <div className="relative">
          <div className="absolute inset-0 bg-green-200 rounded-full animate-ping opacity-30" />
          <CheckCircle className="w-20 h-20 text-green-500" />
        </div>

        <div>
          <h2 className="text-2xl font-bold text-slate-800">{t('status.completeTitle')}</h2>
          <p className="text-slate-500 mt-2">{t('status.zipLocation')}</p>
        </div>

        {/* (15.4) Server download URL with copy button */}
        {serverDownloadUrl && (
          <div className="w-full bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-200 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-indigo-600 flex-shrink-0" />
              <span className="text-sm font-medium text-indigo-900">{t('status.serverDownloadUrl')}</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-indigo-700 bg-white/60 rounded px-3 py-2 break-all select-all">
                {serverDownloadUrl}
              </code>
              <button
                onClick={handleCopyUrl}
                className="flex-shrink-0 p-2 rounded-lg bg-indigo-100 hover:bg-indigo-200 transition-colors cursor-pointer"
                title={t('status.copyUrl')}
              >
                {urlCopied ? (
                  <Check className="w-4 h-4 text-green-600" />
                ) : (
                  <Copy className="w-4 h-4 text-indigo-600" />
                )}
              </button>
            </div>
            {isSingleFile && (
              <div className="flex items-center gap-1.5 mt-1">
                <FileText className="w-3.5 h-3.5 text-indigo-500" />
                <span className="text-xs text-indigo-600">
                  {t('filter.singleFile')}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Extraction Alert - Accordion */}
        <div className="w-full bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-200 rounded-lg overflow-hidden">
          {/* Clickable Header */}
          <button
            onClick={handleToggleAlert}
            className="w-full flex items-center justify-between p-4 hover:bg-blue-100/50 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <Info className="w-5 h-5 text-blue-600 flex-shrink-0" />
              <h3 className="font-semibold text-blue-900 text-sm text-left">
                {t('extraction.alertTitle')}
              </h3>
            </div>
            <ChevronDown
              className={`w-5 h-5 text-blue-600 transition-transform duration-200 flex-shrink-0 ${isAlertExpanded ? 'rotate-180' : ''
                }`}
            />
          </button>

          {/* Collapsible Content */}
          {isAlertExpanded && (
            <div className="px-4 pb-4 space-y-3 animate-scale-in">
              <p className="text-sm text-blue-800 leading-relaxed">
                {t('extraction.alertMessage')}
              </p>
              <div className="space-y-2">
                <p className="text-sm font-medium text-blue-900">
                  {t('extraction.recommendedTools')}
                </p>
                <div className="grid grid-cols-1 gap-2 text-sm">
                  <div className="flex items-center gap-2 bg-white/60 rounded px-3 py-2">
                    <span className="font-medium text-blue-900 min-w-[80px]">
                      {t('extraction.windows')}:
                    </span>
                    <span className="text-blue-700">
                      <a
                        href="https://www.7-zip.org/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-blue-900 transition-colors"
                      >
                        7-Zip
                      </a>
                      {' / '}
                      <a
                        href="https://peazip.github.io/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-blue-900 transition-colors"
                      >
                        PeaZip
                      </a>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 bg-white/60 rounded px-3 py-2">
                    <span className="font-medium text-blue-900 min-w-[80px]">
                      {t('extraction.macOS')}:
                    </span>
                    <span className="text-blue-700">
                      <a
                        href="https://theunarchiver.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-blue-900 transition-colors"
                      >
                        The Unarchiver
                      </a>
                      {' / '}
                      <a
                        href="https://www.keka.io/en/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-blue-900 transition-colors"
                      >
                        Keka
                      </a>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 bg-white/60 rounded px-3 py-2">
                    <span className="font-medium text-blue-900 min-w-[80px]">
                      {t('extraction.ubuntu')}:
                    </span>
                    <span className="text-blue-700">
                      <a
                        href="https://www.7-zip.org/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-blue-900 transition-colors"
                      >
                        7-Zip (CLI)
                      </a>
                      {' / '}
                      <a
                        href="https://peazip.github.io/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline hover:text-blue-900 transition-colors"
                      >
                        PeaZip
                      </a>
                    </span>
                  </div>
                </div>
              </div>

              {/* Hide Next Time Button */}
              <div className="pt-2">
                <button
                  onClick={handleHideNextTime}
                  className="text-sm text-blue-700 hover:text-blue-900 font-medium underline hover:no-underline transition-all cursor-pointer"
                >
                  {t('extraction.hideNextTime')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col w-full gap-3">
          <button
            onClick={handleShowInFolder}
            disabled={!downloadId}
            className="btn-primary w-full flex items-center justify-center gap-2 cursor-pointer"
          >
            <FolderOpen className="w-5 h-5" />
            {t('actions.showInFolder')}
          </button>
          <button
            onClick={handleReset}
            className="btn-secondary w-full flex items-center justify-center gap-2 cursor-pointer"
          >
            <RefreshCcw className="w-5 h-5" />
            {t('actions.downloadAnother')}
          </button>
        </div>

        <div className="pt-6 border-t border-slate-100 w-full">
          <p className="text-sm font-medium text-slate-600 mb-4">{t('rating.prompt')}</p>
          <React.Suspense>
            <div className="flex justify-center">
              <ChromeExtensionRating />
            </div>
          </React.Suspense>
        </div>
      </div>
    </div>
  );
}

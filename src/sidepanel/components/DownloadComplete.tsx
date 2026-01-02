import React, { useEffect, useState } from "react";
import { MessageAction, messageActions } from "../../common/message";
import { useTranslation } from "react-i18next";
import { CheckCircle, FolderOpen, RefreshCcw } from "lucide-react";

const ChromeExtensionRating = React.lazy(
  () => import("../../components/ChromeExtensionRating"),
);

interface DownloadCompleteProps {
  tabId: number;
  tabUrl: string;
  links: string[];
  action: MessageAction | null;
  reset: (newTabUrl: string) => void;
}

export function DownloadComplete({
  tabUrl,
  action,
  reset,
}: DownloadCompleteProps) {
  const { t } = useTranslation();
  const [downloadId, setDownloadId] = useState<number | null>(null);

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

        <div className="flex flex-col w-full gap-3">
          <button
            onClick={handleShowInFolder}
            disabled={!downloadId}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <FolderOpen className="w-5 h-5" />
            {t('actions.showInFolder')}
          </button>
          <button
            onClick={handleReset}
            className="btn-secondary w-full flex items-center justify-center gap-2"
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

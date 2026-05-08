import { useTranslation } from "react-i18next";
import { Cloud, CheckCircle2, AlertCircle, RefreshCw, Loader2 } from "lucide-react";
import { PAGEPOCKET_URL } from "../common/pagepocket-mode";

export interface CloudUploadState {
  status: "uploading" | "success" | "error";
  progress: number; // 0-100
  pageId?: string;
  errorMessage?: string;
  isQuotaError?: boolean;
}

interface CloudUploadStatusProps {
  state: CloudUploadState;
  onRetry?: () => void;
}

export function CloudUploadStatus({ state, onRetry }: CloudUploadStatusProps) {
  const { t } = useTranslation();

  if (state.status === "uploading") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-indigo-600">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{t('status.pagepocketUploading')}</span>
        </div>
        <div className="w-full bg-indigo-100 rounded-full h-2">
          <div
            className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${Math.max(2, state.progress)}%` }}
          />
        </div>
        <p className="text-xs text-slate-500">
          {t('status.pagepocketUploadProgress', { progress: Math.round(state.progress) })}
        </p>
      </div>
    );
  }

  if (state.status === "success") {
    const viewUrl = PAGEPOCKET_URL
      ? `${PAGEPOCKET_URL}/pages/${state.pageId}`
      : undefined;

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-green-700">
          <CheckCircle2 className="w-5 h-5" />
          <span>{t('status.pagepocketUploadComplete')}</span>
        </div>
        {state.pageId && viewUrl && (
          <a
            href={viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
          >
            <Cloud className="w-3 h-3" />
            {t('status.pagepocketViewPage')}
          </a>
        )}
      </div>
    );
  }

  // error
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 text-sm text-red-700">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <span>
            {state.isQuotaError
              ? t('status.pagepocketQuotaExceeded')
              : state.errorMessage || t('status.pagepocketUploadError')}
          </span>
        </div>
      </div>
      {onRetry && !state.isQuotaError && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
        >
          <RefreshCw className="w-3 h-3" />
          {t('status.pagepocketUploadRetry')}
        </button>
      )}
    </div>
  );
}

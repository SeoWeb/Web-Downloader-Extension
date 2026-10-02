import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, X, Check } from "lucide-react";
import { Button } from "./Button";
import { IS_PAGEPOCKET_AVAILABLE } from "../common/pagepocket-mode";
import { usePagePocket } from "../hooks/usePagePocket";

const STORAGE_KEY = "pagepocket-announcement-dismissed";

export function PagePocketAnnouncement() {
  const { t } = useTranslation();
  const { setCloudStorageEnabled } = usePagePocket();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!IS_PAGEPOCKET_AVAILABLE) return;

    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (!result[STORAGE_KEY]) {
        setShow(true);
      }
    });
  }, []);

  const handleGetStarted = () => {
    chrome.storage.local.set({ [STORAGE_KEY]: true });
    setCloudStorageEnabled(true);
    setShow(false);
  };

  const handleMaybeLater = () => {
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in p-4">
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden animate-scale-in">
        {/* Close button */}
        <button
          onClick={handleMaybeLater}
          className="absolute top-3 right-3 z-10 p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Header */}
        <div className="bg-gradient-to-br from-indigo-500 to-purple-600 px-6 pt-6 pb-8 text-white">
          <div className="flex items-center gap-2 mb-3">
            <Cloud className="h-6 w-6" />
            <span className="text-sm font-medium uppercase tracking-wider opacity-80">
              New Feature
            </span>
          </div>
          <h2 className="text-xl font-bold">
            {t("pagepocketAnnouncement.title")}
          </h2>
          <p className="mt-2 text-sm text-white/80 leading-relaxed">
            {t("pagepocketAnnouncement.description")}
          </p>
        </div>

        {/* Body — Starter plan */}
        <div className="px-5 pt-5 pb-5 space-y-3">
          <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50/40 p-4 relative">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-700">
                {t("pagepocketAnnouncement.freeLabel")}
              </span>
              <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                {t("pagepocketAnnouncement.freeBadge")}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              {t("pagepocketAnnouncement.freeTier")}
            </p>
            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-700">
              <Check className="h-3.5 w-3.5 flex-shrink-0" />
              {t("pagepocketAnnouncement.freeNoLimit")}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-5 flex flex-col gap-2">
          <Button onClick={handleGetStarted} className="w-full">
            <Cloud className="h-4 w-4 mr-2" />
            {t("pagepocketAnnouncement.getStarted")}
          </Button>
          <button
            onClick={handleMaybeLater}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors text-center py-1"
          >
            {t("pagepocketAnnouncement.maybeLater")}
          </button>
        </div>
      </div>
    </div>
  );
}

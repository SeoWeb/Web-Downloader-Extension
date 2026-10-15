import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";

/**
 * Unsupported-page state (task 5.1 / design D8).
 *
 * Rendered in place of the download form when the active tab cannot be
 * scripted (chrome://, edge://, Web Store, file://, non-http(s)), so a
 * doomed download can never be started.
 */
export function UnsupportedPage() {
  const { t } = useTranslation();

  return (
    <div className="pt-4 animate-fade-in">
      <div className="card p-6 bg-gradient-to-b from-amber-50 to-white border-amber-200 space-y-3">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-8 h-8 text-amber-500 flex-shrink-0" />
          <h3 className="font-bold text-slate-800">
            {t("tab.unsupportedTitle")}
          </h3>
        </div>
        <p className="text-sm text-slate-600 leading-relaxed">
          {t("tab.unsupportedDescription")}
        </p>
      </div>
    </div>
  );
}

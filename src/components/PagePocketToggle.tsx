import { useTranslation } from "react-i18next";
import { Checkbox } from "./Checkbox";
import { CheckedState } from "@radix-ui/react-checkbox";
import { Cloud, LogOut } from "lucide-react";
import cn from "classnames";
import { IS_PAGEPOCKET_AVAILABLE } from "../common/pagepocket-mode";
import { usePagePocket } from "../hooks/usePagePocket";

export function PagePocketToggle() {
  const { t } = useTranslation();
  const {
    cloudStorageEnabled,
    isAuthenticated,
    authUser,
    setCloudStorageEnabled,
    logout,
  } = usePagePocket();

  if (!IS_PAGEPOCKET_AVAILABLE) return null;

  const handleCheckedChange = (checked: CheckedState) => {
    setCloudStorageEnabled(!!checked);
  };

  return (
    <div className="p-3 bg-indigo-50 rounded-lg border border-indigo-100">
      <div className="flex items-center gap-3">
        <Checkbox
          id="cloudStorage"
          checked={cloudStorageEnabled}
          onCheckedChange={handleCheckedChange}
        />
        <label htmlFor="cloudStorage" className="flex-1 cursor-pointer">
          <div className="font-medium text-slate-900">{t('filter.cloudStorage')}</div>
          <div className="text-xs text-slate-500">{t('filter.cloudStorageDescription')}</div>
        </label>
        <Cloud className="w-5 h-5 text-indigo-400" />
      </div>

      {cloudStorageEnabled && (
        <div className={cn(
          "mt-2 pt-2 border-t border-indigo-200 flex items-center justify-between text-xs",
        )}>
          {isAuthenticated && authUser ? (
            <span className="text-green-700 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
              {t('filter.cloudLoggedInAs', { email: authUser.email })}
            </span>
          ) : (
            <span className="text-amber-700 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
              {t('filter.cloudLoginRequired')}
            </span>
          )}
          {isAuthenticated && (
            <button
              onClick={logout}
              className="text-indigo-600 hover:text-indigo-800 flex items-center gap-1 cursor-pointer"
            >
              <LogOut className="w-3 h-3" />
              {t('filter.cloudLogout')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

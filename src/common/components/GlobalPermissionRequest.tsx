import { Button } from "../../components/Button";
import { useTranslation } from "react-i18next";

interface GlobalPermissionRequestProps {
  onRequestPermission: () => Promise<void>;
  requesting: boolean;
  error?: string | null;
}

export function GlobalPermissionRequest({
  onRequestPermission,
  requesting,
  error,
}: GlobalPermissionRequestProps) {
  const { t } = useTranslation();
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
      <div className="mb-4">
        <div className="text-3xl mb-2">🔒</div>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          {t('permissions.global.title')}
        </h2>
        <p className="text-sm text-gray-600 mb-4 leading-relaxed">
          {t('permissions.global.description')}
        </p>
        <div className="text-xs text-gray-500 mb-3 text-left">
          <div className="mb-3">
            <strong>{t('permissions.global.storage.title')}</strong>
            <br />
            {t('permissions.global.storage.description')}
          </div>

        </div>
        <div className="text-xs text-gray-500 mb-4 text-left">
          <div className="mb-2">
            <strong>{t('permissions.global.storageDetails.title')}</strong>
            <br />• {t('permissions.global.storageDetails.preferences')}
          </div>
          <div>
            <strong>{t('permissions.global.privacy.title')}</strong>
            <br />• {t('permissions.global.privacy.personal')}
            <br />• {t('permissions.global.privacy.history')}
            <br />• {t('permissions.global.privacy.local')}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <Button
        onClick={onRequestPermission}
        disabled={requesting}
        className="px-6 py-2"
      >
        {requesting ? t('permissions.global.button.requesting') : t('permissions.global.button.enable')}
      </Button>

      <p className="text-xs text-gray-500 mt-3">
        {t('permissions.global.footer')}
      </p>
    </div>
  );
}

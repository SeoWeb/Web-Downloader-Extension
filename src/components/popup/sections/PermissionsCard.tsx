import { useState, useEffect, useMemo } from "react";
import StaticCard from "../../ui/StaticCard";
import { KeyRound } from "lucide-react";
import { useLanguageStore } from "../../../store/languageStore";
import { DownloadMode } from "../../../store/downloadSettingsStore";
import PermissionsList from "./PermissionsList";
import PermissionStatus from "./PermissionStatus";
import PermissionRequestButton from "./PermissionRequestButton";

const BASE_PERMISSIONS: chrome.runtime.ManifestPermissions[] = [
  "activeTab",
  "scripting",
  "downloads",
  "storage",
];

interface PermissionsCardProps {
  hasPermissions: boolean;
  setHasPermissions: (set: boolean) => void;
  downloadMode: DownloadMode;
}

export default function PermissionsCard({
  hasPermissions,
  setHasPermissions,
  downloadMode, // Added downloadMode
}: PermissionsCardProps) {
  const { direction, getTranslation } = useLanguageStore();
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Define effective permissions based on downloadMode
  const getEffectivePermissions = (
    mode: DownloadMode,
  ): chrome.permissions.Permissions => {
    const basePermissions: chrome.runtime.ManifestPermissions[] =
      BASE_PERMISSIONS;
    // if (mode === "single_file") {
    //   return { permissions: [...basePermissions, "pageCapture"] };
    // }
    return { permissions: basePermissions };
  };

  // Memoize effectivePermissions to stabilize it for useEffect dependencies
  const effectivePermissions = useMemo(
    () => getEffectivePermissions(downloadMode),
    [downloadMode],
  );

  useEffect(() => {
    const checkAndProceed = async () => {
      try {
        const granted = await chrome.permissions.contains(effectivePermissions); // Use effectivePermissions
        setHasPermissions(granted);
        setError(null); // Clear previous errors
      } catch (err) {
        setError(getTranslation("permission_check_error"));
        setHasPermissions(false); // Assume no permissions on error
      }
    };
    checkAndProceed();
  }, [effectivePermissions, setHasPermissions, getTranslation]); // Updated dependencies

  const requestPermissions = async () => {
    setIsRequesting(true);
    setError(null);
    try {
      const granted = await chrome.permissions.request(effectivePermissions); // Use effectivePermissions
      setHasPermissions(granted);
      if (!granted) {
        setError(getTranslation("permission_not_granted_error"));
      }
    } catch (err) {
      setError(getTranslation("permission_request_error"));
      setHasPermissions(false);
    } finally {
      setIsRequesting(false);
    }
  };

  const renderContent = () => {
    return (
      <>
        <PermissionStatus
          hasPermissions={hasPermissions}
          error={error}
          direction={direction}
        />
        <PermissionsList
          effectivePermissions={effectivePermissions}
          direction={direction}
        />
        {!hasPermissions && (
          <PermissionRequestButton
            isRequesting={isRequesting}
            requestPermissions={requestPermissions}
          />
        )}
      </>
    );
  };

  return (
    <StaticCard
      title={getTranslation("permissions_title")}
      icon={<KeyRound className="h-5 w-5 text-white" />}
    >
      {renderContent()}
    </StaticCard>
  );
}

import { useState, useEffect } from "react";
import StaticCard from "../../ui/StaticCard"; // Import StaticCard correctly
import { AlertTriangle, CheckCircle, KeyRound } from "lucide-react"; // Add KeyRound icon
import PrimaryButton from "../../ui/PrimaryButton";
import { useLanguageStore } from "../../../store/languageStore";

const REQUIRED_PERMISSIONS: chrome.permissions.Permissions = {
  permissions: ["activeTab", "scripting", "downloads", "storage"],
};

interface PermissionsCardProps {
  hasPermissions: boolean;
  setHasPermissions: (set: boolean) => void;
}

export default function PermissionsCard({
  hasPermissions,
  setHasPermissions,
}: PermissionsCardProps) {
  const { direction, getTranslation } = useLanguageStore();
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkAndProceed = async () => {
      try {
        const granted = await chrome.permissions.contains(REQUIRED_PERMISSIONS);
        setHasPermissions(granted);
        setError(null); // Clear previous errors
      } catch (err) {
        setError(getTranslation("permission_check_error"));
        setHasPermissions(false); // Assume no permissions on error
      }
    };
    checkAndProceed();
  }, []);

  const requestPermissions = async () => {
    setIsRequesting(true);
    setError(null);
    try {
      const granted = await chrome.permissions.request(REQUIRED_PERMISSIONS);
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
    if (error) {
      return (
        <div className="text-red-600 flex items-center gap-2">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      );
    }

    const renderPermissions = () => (
      <>
        <p
          className={`text-sm text-slate-600 mb-2 flex ${direction === "rtl" ? "text-right flex-row-reverse" : ""}`}
        >
          {getTranslation("permissions_intro")}
          <span>:</span>
        </p>
        <ul className="list-disc list-inside space-y-1 text-sm text-slate-500 mb-4">
          <PermissionItem
            direction={direction}
            label={getTranslation("permission_activeTab")}
            description={getTranslation("permission_activeTab_description")}
          />
          <PermissionItem
            direction={direction}
            label={getTranslation("permission_scripting")}
            description={getTranslation("permission_scripting_description")}
          />
          <PermissionItem
            direction={direction}
            label={getTranslation("permission_downloads")}
            description={getTranslation("permission_downloads_description")}
          />
          <PermissionItem
            direction={direction}
            label={getTranslation("permission_storage")}
            description={getTranslation("permission_storage_description")}
          />
        </ul>
      </>
    );

    if (hasPermissions) {
      return (
        <div>
          <div className="flex items-center text-green-600 mb-4">
            <CheckCircle size={20} className="mr-2" />
            <p className="font-semibold">
              {getTranslation("permissions_granted")}
            </p>
          </div>
          {renderPermissions()}
        </div>
      );
    }

    // Permissions not granted, show request UI
    return (
      <div
        className={`flex flex-col justify-start ${direction === "rtl" ? "items-end" : "items-start"}`}
      >
        <div
          className={`flex items-center text-orange-600 mb-4 gap-2 ${direction === "rtl" ? "flex-row-reverse" : ""}`}
        >
          <AlertTriangle size={20} />
          <p
            className={`font-semibold flex ${direction === "rtl" ? "flex-row-reverse" : ""}`}
          >
            {getTranslation("permissions_message")}
            <span>:</span>
          </p>
        </div>
        {renderPermissions()}
        <PrimaryButton onClick={requestPermissions} disabled={isRequesting}>
          {isRequesting
            ? getTranslation("requesting_permissions")
            : getTranslation("grant_permissions")}
        </PrimaryButton>
      </div>
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

function PermissionItem({
  direction,
  label,
  description,
}: {
  direction: string;
  label: string;
  description: string;
}) {
  return (
    <li
      className={`flex items-center gap-1 ${direction === "rtl" ? "flex-row-reverse" : ""}`}
    >
      <strong
        className={`flex items-center ${direction === "rtl" ? "flex-row-reverse" : ""}`}
      >
        {label}
        <span>:</span>
      </strong>
      <span>{description}</span>
    </li>
  );
}

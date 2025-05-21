import PermissionItem from "../../ui/PermissionItem";
import { useLanguageStore } from "../../../store/languageStore";

interface PermissionsListProps {
  effectivePermissions: chrome.permissions.Permissions;
  direction: string;
}

export default function PermissionsList({
  effectivePermissions,
  direction,
}: PermissionsListProps) {
  const { getTranslation } = useLanguageStore();

  return (
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
        {/* Conditionally render pageCapture permission */}
        {effectivePermissions.permissions?.includes("pageCapture") && (
          <PermissionItem
            direction={direction}
            label={getTranslation("permission_pageCapture")}
            description={getTranslation("permission_pageCapture_description")}
          />
        )}
      </ul>
    </>
  );
}

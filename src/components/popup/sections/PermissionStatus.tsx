import { AlertTriangle, CheckCircle } from "lucide-react";
import { useLanguageStore } from "../../../store/languageStore";

interface PermissionStatusProps {
  hasPermissions: boolean;
  error: string | null;
  direction: string;
}

export default function PermissionStatus({
  hasPermissions,
  error,
  direction,
}: PermissionStatusProps) {
  const { getTranslation } = useLanguageStore();

  if (error) {
    return (
      <div className="text-red-600 flex items-center gap-2">
        <AlertTriangle size={18} />
        <span>{error}</span>
      </div>
    );
  }

  if (hasPermissions) {
    return (
      <div className="flex items-center text-green-600 mb-4">
        <CheckCircle size={20} className="mr-2" />
        <p className="font-semibold">{getTranslation("permissions_granted")}</p>
      </div>
    );
  }

  return (
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
  );
}

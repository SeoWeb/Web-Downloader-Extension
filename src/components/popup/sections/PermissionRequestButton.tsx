import PrimaryButton from "../../ui/PrimaryButton";
import { useLanguageStore } from "../../../store/languageStore";

interface PermissionRequestButtonProps {
  isRequesting: boolean;
  requestPermissions: () => void;
}

export default function PermissionRequestButton({
  isRequesting,
  requestPermissions,
}: PermissionRequestButtonProps) {
  const { getTranslation } = useLanguageStore();

  return (
    <PrimaryButton onClick={requestPermissions} disabled={isRequesting}>
      {isRequesting
        ? getTranslation("requesting_permissions")
        : getTranslation("grant_permissions")}
    </PrimaryButton>
  );
}

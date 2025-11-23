import { useGlobalUserId } from "../../common/hooks/useGlobalUserId";

/**
 * @deprecated Use useGlobalUserId instead for consistency across the extension
 * This hook is kept for backward compatibility with existing feature request components
 */
export function useUserId() {
  const globalUserIdData = useGlobalUserId();

  return {
    userId: globalUserIdData.userId,
    loading: globalUserIdData.loading,
    error: globalUserIdData.error,
    hasPermission: globalUserIdData.hasPermission,
    permissionRequesting: globalUserIdData.permissionRequesting,
    requestPermission: globalUserIdData.requestPermission,
  };
}

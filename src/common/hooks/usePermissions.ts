import { useState, useEffect, useCallback } from "react";
import {
  hasStoragePermission,
} from "../permissions";

export interface UsePermissionsReturn {
  hasPermission: boolean;
  permissionRequesting: boolean;
  error: string | null;
  requestPermission: () => Promise<void>;
  checkPermissions: () => Promise<void>;
  loading: boolean;
}

/**
 * Hook to manage global permissions (storage)
 */
export function usePermissions(): UsePermissionsReturn {
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [permissionRequesting, setPermissionRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const checkPermissions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // We primarily check for storage permission to determine if we show the main app

      const storage = await hasStoragePermission();
      setHasPermission(storage);
    } catch {
      setError("Failed to check permissions");
    } finally {
      setLoading(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      setPermissionRequesting(true);
      setError(null);

      // Request storage permission
      // We check for storage permission to determine if we show the main app
      
      const granted = await chrome.permissions.request({ 
        permissions: ["storage"] 
      });
      
      if (granted) {
        await checkPermissions();
      } else {
        setError("Storage permission is required to use this extension");
      }
    } catch {
      setError("Failed to request permissions");
    } finally {
      setPermissionRequesting(false);
    }
  }, [checkPermissions]);

  useEffect(() => {
    checkPermissions();
  }, [checkPermissions]);

  return {
    hasPermission,
    permissionRequesting,
    error,
    requestPermission,
    checkPermissions,
    loading,
  };
}

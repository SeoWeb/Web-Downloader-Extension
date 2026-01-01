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
 * Hook to manage global permissions (storage, offscreen)
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
      // Offscreen might be requested on demand or together, but storage is critical for settings
      const storage = await hasStoragePermission();
      setHasPermission(storage);
    } catch (err) {
      console.error("Error checking permissions:", err);
      setError("Failed to check permissions");
    } finally {
      setLoading(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      setPermissionRequesting(true);
      setError(null);

      // Request both storage and offscreen permissions together
      // We can't use the wrapper functions easily for a single combined request 
      // if we want them in one prompt, so we use chrome.permissions.request directly here
      // or we can chain them. Chrome usually prefers one user gesture for multiple permissions if possible.
      // The original code requested { permissions: ["storage", "offscreen"] }
      
      const granted = await chrome.permissions.request({ 
        permissions: ["storage", "offscreen"] 
      });
      
      if (granted) {
        await checkPermissions();
      } else {
        setError("Storage and offscreen permissions are required to use this extension");
      }
    } catch (err) {
      console.error("Error requesting permissions:", err);
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

import { useState, useEffect, useCallback } from 'react';
import { getUserId, hasStoragePermission, requestStoragePermission } from '../../background/userIdManager';

export interface UseGlobalUserIdReturn {
  userId: number | null;
  loading: boolean;
  error: string | null;
  hasPermission: boolean;
  permissionRequesting: boolean;
  requestPermission: () => Promise<void>;
  refreshUserId: () => Promise<void>;
}

/**
 * Global hook for managing user ID across the entire extension
 * Can be used in sidepanel, feature requests, and any other components
 */
export function useGlobalUserId(): UseGlobalUserIdReturn {
  const [userId, setUserId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [permissionRequesting, setPermissionRequesting] = useState(false);

  const checkPermissionAndFetchUserId = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Check if we have storage permission
      const permission = await hasStoragePermission();
      setHasPermission(permission);
      
      if (permission) {
        const id = await getUserId();
        setUserId(id);
      } else {
        setUserId(null);
      }
    } catch (err) {
      console.error('Error fetching user ID:', err);
      setError('Failed to get user ID');
    } finally {
      setLoading(false);
    }
  }, []);

  const requestPermission = useCallback(async () => {
    try {
      setPermissionRequesting(true);
      setError(null);
      
      const granted = await requestStoragePermission();
      if (granted) {
        // Permission granted, now fetch user ID
        await checkPermissionAndFetchUserId();
      } else {
        setError('Storage permission is required to use this extension');
      }
    } catch (err) {
      console.error('Error requesting permission:', err);
      setError('Failed to request storage permission');
    } finally {
      setPermissionRequesting(false);
    }
  }, [checkPermissionAndFetchUserId]);

  const refreshUserId = useCallback(async () => {
    await checkPermissionAndFetchUserId();
  }, [checkPermissionAndFetchUserId]);

  useEffect(() => {
    checkPermissionAndFetchUserId();
  }, [checkPermissionAndFetchUserId]);

  return {
    userId,
    loading,
    error,
    hasPermission,
    permissionRequesting,
    requestPermission,
    refreshUserId
  };
}
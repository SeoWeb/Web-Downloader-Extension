import { useEffect } from "react";
import { usePagePocketStore } from "../stores/pagepocketStore";

export function usePagePocket() {
  const {
    cloudStorageEnabled,
    isAuthenticated,
    authUser,
    isAuthLoading,
    setCloudStorageEnabled,
    login,
    register,
    googleLogin,
    logout,
    initializeFromStorage,
  } = usePagePocketStore();

  const isInitialized = usePagePocketStore(
    (s) => s.isAuthenticated !== undefined,
  );

  useEffect(() => {
    initializeFromStorage();
  }, [initializeFromStorage]);

  return {
    cloudStorageEnabled,
    isAuthenticated,
    authUser,
    isAuthLoading,
    isInitialized,
    setCloudStorageEnabled,
    login,
    register,
    googleLogin,
    logout,
  };
}

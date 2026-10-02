import { useEffect } from "react";
import { useFilterStore } from "../stores/filterStore";

/**
 * Hook for accessing and managing filter options
 * Automatically initializes from storage on first use
 */
export function useFilterOptions() {
  const {
    options,
    isLoading,
    isInitialized,
    hasStorageError,
    storageErrorMessage,
    setFilterOption,
    setAllOptions,
    resetToDefaults,
    initializeFromStorage,
    clearStorageError,
    hasAnyContentSelected,
    isValidConfiguration,
  } = useFilterStore();

  // Initialize from storage on mount
  useEffect(() => {
    if (!isInitialized) {
      initializeFromStorage();
    }
  }, [isInitialized, initializeFromStorage]);

  return {
    // State
    options,
    isLoading,
    isInitialized,
    hasStorageError,
    storageErrorMessage,

    // Actions
    setFilterOption,
    setAllOptions,
    resetToDefaults,
    clearStorageError,

    // Computed values
    hasAnyContentSelected: hasAnyContentSelected(),
    isValidConfiguration: isValidConfiguration(),

    // Convenience methods for specific options
    setDownloadHTML: (value: boolean) => setFilterOption("downloadHTML", value),
    setDownloadImages: (value: boolean) =>
      setFilterOption("downloadImages", value),
    setDownloadLinks: (value: boolean) =>
      setFilterOption("downloadLinks", value),
    setDownloadAssets: (value: boolean) =>
      setFilterOption("downloadAssets", value),
    setDownloadContentAsText: (value: boolean) =>
      setFilterOption("downloadContentAsText", value),
    setDownloadDocuments: (value: boolean) =>
      setFilterOption("downloadDocuments", value),
    setSingleFile: (value: boolean) => setFilterOption("singleFile", value),

    // Full scraping options
    setDownloadLinksFullScraping: (value: boolean) =>
      setFilterOption("downloadLinksFullScraping", value),
    setLinkedPagesMaxCount: (value: number) =>
      setFilterOption("linkedPagesMaxCount", value),
    setLinkedPagesDelay: (value: number) =>
      setFilterOption("linkedPagesDelay", value),
    setLinkedPagesIncludeExternal: (value: boolean) =>
      setFilterOption("linkedPagesIncludeExternal", value),
    setLinkedPagesTimeout: (value: number) =>
      setFilterOption("linkedPagesTimeout", value),
    setAlwaysAskWhereToSave: (value: boolean) =>
      setFilterOption("alwaysAskWhereToSave", value),
  };
}

/**
 * Hook for getting current filter options as download parameters
 * Returns the options in the format expected by the download function
 */
export function useDownloadOptions() {
  const { options, isInitialized, initializeFromStorage } = useFilterStore();

  // Initialize from storage on mount
  useEffect(() => {
    if (!isInitialized) {
      initializeFromStorage();
    }
  }, [isInitialized, initializeFromStorage]);

  return {
    downloadHTML: options.downloadHTML,
    downloadImages: options.downloadImages,
    downloadLinks: options.downloadLinks,
    downloadAssets: options.downloadAssets,
    downloadContentAsText: options.downloadContentAsText,
    downloadDocuments: options.downloadDocuments,
    singleFile: options.singleFile,

    // Full scraping options
    downloadLinksFullScraping: options.downloadLinksFullScraping,
    linkedPagesMaxCount: options.linkedPagesMaxCount,
    linkedPagesDelay: options.linkedPagesDelay,
    linkedPagesIncludeExternal: options.linkedPagesIncludeExternal,
    linkedPagesTimeout: options.linkedPagesTimeout,
    alwaysAskWhereToSave: options.alwaysAskWhereToSave,
  };
}

/**
 * Hook for checking if storage is available and working
 */
export function useStorageStatus() {
  const { isInitialized, isLoading, hasStorageError, storageErrorMessage } =
    useFilterStore();

  return {
    isStorageAvailable: isInitialized && !hasStorageError,
    isLoadingFromStorage: isLoading,
    isReady: isInitialized && !isLoading,
    hasError: hasStorageError,
    errorMessage: storageErrorMessage,
  };
}

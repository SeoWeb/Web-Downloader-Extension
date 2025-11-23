import { useEffect } from "react";
import { useFilterStore } from "../stores/filterStore";
import { FilterOptions } from "../types/filterTypes";

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
  };
}

/**
 * Hook for accessing individual filter option
 * @param key - The filter option key
 * @returns [value, setter] tuple
 */
export function useFilterOption<K extends keyof FilterOptions>(
  key: K,
): [FilterOptions[K], (value: FilterOptions[K]) => void, boolean] {
  const {
    options,
    setFilterOption,
    isInitialized,
    initializeFromStorage,
    hasStorageError,
  } = useFilterStore();

  // Initialize from storage on mount
  useEffect(() => {
    if (!isInitialized) {
      initializeFromStorage();
    }
  }, [isInitialized, initializeFromStorage]);

  const setValue = (value: FilterOptions[K]) => {
    setFilterOption(key, value);
  };

  return [options[key], setValue, hasStorageError];
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

import { useEffect } from "react";
import { useFilterStore } from "../stores/filterStore";
import { normalizeTextOnlyOptions } from "../types/filterTypes";

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
    setDownloadContentAsMarkdown: (value: boolean) =>
      setFilterOption("downloadContentAsMarkdown", value),
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

  // text-native-downloads D7: in text-only mode (HTML off + a text format
  // on) the images/assets/documents/single-file toggles are disabled in
  // the UI and must not affect the outgoing options — their stored values
  // are neutralized here while the store keeps the user's preferences.
  const outgoing = normalizeTextOnlyOptions(options);

  return {
    downloadHTML: outgoing.downloadHTML,
    downloadImages: outgoing.downloadImages,
    downloadLinks: outgoing.downloadLinks,
    downloadAssets: outgoing.downloadAssets,
    downloadContentAsText: outgoing.downloadContentAsText,
    downloadContentAsMarkdown: outgoing.downloadContentAsMarkdown ?? false,
    downloadDocuments: outgoing.downloadDocuments,
    singleFile: outgoing.singleFile,

    // Full scraping options
    downloadLinksFullScraping: outgoing.downloadLinksFullScraping,
    linkedPagesMaxCount: outgoing.linkedPagesMaxCount,
    linkedPagesDelay: outgoing.linkedPagesDelay,
    linkedPagesIncludeExternal: outgoing.linkedPagesIncludeExternal,
    linkedPagesTimeout: outgoing.linkedPagesTimeout,
    alwaysAskWhereToSave: outgoing.alwaysAskWhereToSave,
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

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { FilterOptions, DEFAULT_FILTER_OPTIONS } from "../types/filterTypes";
import {
  loadFilterOptions,
  saveFilterOptions,
  migrateFilterOptions,
} from "../common/storage/filterStorage";
import {
  analyzeStorageError,
  recoverFromStorageError,
} from "../common/storage/storageErrorHandler";

interface FilterState {
  // State
  options: FilterOptions;
  isLoading: boolean;
  isInitialized: boolean;
  hasStorageError: boolean;
  storageErrorMessage: string | null;

  // Actions
  setFilterOption: <K extends keyof FilterOptions>(
    key: K,
    value: FilterOptions[K],
  ) => void;
  setAllOptions: (options: FilterOptions) => void;
  resetToDefaults: () => void;
  initializeFromStorage: () => Promise<void>;
  clearStorageError: () => void;

  // Computed getters
  hasAnyContentSelected: () => boolean;
  isValidConfiguration: () => boolean;
}

/**
 * Validates filter options according to business rules
 */
function validateFilterOptions(options: FilterOptions): FilterOptions {
  const validated = { ...options };

  // If singleFile is selected, keep HTML, images, and assets on: the
  // single-file output is one self-contained HTML file, so it is an HTML
  // download whose images and styles/assets MUST be scraped and uploaded —
  // the server inlines them as base64 data URIs. Without them the output
  // has broken references. Crawling and the other granular formats stay
  // off: single-file mode downloads the current page only, as HTML.
  if (validated.singleFile) {
    return {
      ...DEFAULT_FILTER_OPTIONS,
      singleFile: true,
      downloadHTML: true,
      downloadImages: true,
      downloadLinks: false,
      downloadLinksFullScraping: false,
      downloadAssets: true,
      downloadContentAsText: false,
      downloadContentAsMarkdown: false,
      downloadDocuments: false,
    };
  }

  // If no content options are selected, enable defaults
  const hasContent =
    validated.downloadHTML ||
    validated.downloadImages ||
    validated.downloadLinks ||
    validated.downloadAssets ||
    validated.downloadContentAsText ||
    validated.downloadContentAsMarkdown ||
    validated.downloadDocuments;

  if (!hasContent) {
    validated.downloadHTML = true;
    validated.downloadImages = true;
    validated.downloadAssets = true;
  }

  // If HTML is enabled, enable images and assets by default
  if (validated.downloadHTML) {
    validated.downloadImages = true;
    validated.downloadAssets = true;
  }

  // If HTML is disabled, disable links and assets. Crawling
  // (downloadLinksFullScraping) stays allowed here — a text-only download
  // may still legitimately crawl linked pages.
  if (!validated.downloadHTML) {
    validated.downloadLinks = false;
    validated.downloadAssets = false;
  }

  return validated;
}

export const useFilterStore = create<FilterState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    options: DEFAULT_FILTER_OPTIONS,
    isLoading: false,
    isInitialized: false,
    hasStorageError: false,
    storageErrorMessage: null,

    // Actions
    setFilterOption: (key, value) => {
      const currentOptions = get().options;
      const newOptions = { ...currentOptions, [key]: value };
      const validatedOptions = validateFilterOptions(newOptions);

      set({
        options: validatedOptions,
        hasStorageError: false,
        storageErrorMessage: null,
      });

      // Save to Chrome storage asynchronously
      saveFilterOptions(validatedOptions).catch((error) => {
        const storageError = analyzeStorageError(error);
        set({
          hasStorageError: true,
          storageErrorMessage: storageError.message,
        });
      });
    },

    setAllOptions: (options) => {
      const validatedOptions = validateFilterOptions(options);
      set({
        options: validatedOptions,
        hasStorageError: false,
        storageErrorMessage: null,
      });

      // Save to Chrome storage asynchronously
      saveFilterOptions(validatedOptions).catch((error) => {
        const storageError = analyzeStorageError(error);
        set({
          hasStorageError: true,
          storageErrorMessage: storageError.message,
        });
      });
    },

    resetToDefaults: () => {
      set({
        options: DEFAULT_FILTER_OPTIONS,
        hasStorageError: false,
        storageErrorMessage: null,
      });

      // Save defaults to Chrome storage asynchronously
      saveFilterOptions(DEFAULT_FILTER_OPTIONS).catch((error) => {
        const storageError = analyzeStorageError(error);
        set({
          hasStorageError: true,
          storageErrorMessage: storageError.message,
        });
      });
    },

    initializeFromStorage: async () => {
      set({
        isLoading: true,
        hasStorageError: false,
        storageErrorMessage: null,
      });

      try {
        // Run migration first
        await migrateFilterOptions();

        // Load options from storage
        const storedOptions = await loadFilterOptions();
        const validatedOptions = validateFilterOptions(storedOptions);

        set({
          options: validatedOptions,
          isLoading: false,
          isInitialized: true,
          hasStorageError: false,
          storageErrorMessage: null,
        });
      } catch (error) {
        // Attempt recovery
        const storageError = analyzeStorageError(error);
        const recoveredOptions = await recoverFromStorageError(
          storageError,
          DEFAULT_FILTER_OPTIONS,
        );

        set({
          options: recoveredOptions,
          isLoading: false,
          isInitialized: true,
          hasStorageError: true,
          storageErrorMessage: storageError.message,
        });
      }
    },

    clearStorageError: () => {
      set({ hasStorageError: false, storageErrorMessage: null });
    },

    // Computed getters
    hasAnyContentSelected: () => {
      const { options } = get();
      return (
        options.downloadHTML ||
        options.downloadImages ||
        options.downloadLinks ||
        options.downloadAssets ||
        options.downloadContentAsText ||
        options.downloadContentAsMarkdown ||
        options.downloadDocuments ||
        options.singleFile
      );
    },

    isValidConfiguration: () => {
      const { options } = get();

      // Single file is always valid
      if (options.singleFile) {
        return true;
      }

      // At least one content type must be selected
      return (
        options.downloadHTML ||
        options.downloadImages ||
        options.downloadLinks ||
        options.downloadAssets ||
        options.downloadContentAsText ||
        options.downloadContentAsMarkdown ||
        options.downloadDocuments
      );
    },
  })),
);

// Subscribe to storage changes (if needed for cross-tab synchronization)
if (typeof chrome !== "undefined" && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.webPageDownloader_filterOptions) {
      const newValue = changes.webPageDownloader_filterOptions.newValue;
      if (newValue) {
        const validatedOptions = validateFilterOptions(newValue);
        useFilterStore.setState({ options: validatedOptions });
      }
    }
  });
}

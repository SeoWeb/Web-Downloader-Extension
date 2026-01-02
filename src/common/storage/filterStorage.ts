import {
  FilterOptions,
  DEFAULT_FILTER_OPTIONS,
  FILTER_OPTIONS_STORAGE_KEY,
} from "../../types/filterTypes";
import {
  hasStoragePermission,
} from "../permissions";
import {
  validateFilterOptions,
  safeStorageOperation,
} from "./storageErrorHandler";

/**
 * Loads filter options from Chrome storage
 * @returns Promise<FilterOptions> - Filter options or defaults if not found/error
 */
export async function loadFilterOptions(): Promise<FilterOptions> {
  return safeStorageOperation(
    async () => {
      // Check if we have storage permission
      const hasPermission = await hasStoragePermission();
      if (!hasPermission) {
        console.log(
          "Storage permission not granted, using default filter options",
        );
        return DEFAULT_FILTER_OPTIONS;
      }

      // Try to get existing filter options from storage
      const result = await chrome.storage.local.get([
        FILTER_OPTIONS_STORAGE_KEY,
      ]);

      if (result[FILTER_OPTIONS_STORAGE_KEY]) {
        // Validate the stored data
        const validatedOptions = validateFilterOptions(
          result[FILTER_OPTIONS_STORAGE_KEY],
        );

        if (validatedOptions) {
          // Merge with defaults to ensure all properties exist (for backward compatibility)
          return {
            ...DEFAULT_FILTER_OPTIONS,
            ...validatedOptions,
          };
        } else {
          console.warn("Stored filter options are invalid, using defaults");
          // Clear invalid data
          await chrome.storage.local.remove([FILTER_OPTIONS_STORAGE_KEY]);
          return DEFAULT_FILTER_OPTIONS;
        }
      }

      // No stored options found, return defaults
      return DEFAULT_FILTER_OPTIONS;
    },
    DEFAULT_FILTER_OPTIONS,
    "loadFilterOptions",
  );
}

/**
 * Saves filter options to Chrome storage
 * @param options - Filter options to save
 * @returns Promise<boolean> - Success status
 */
export async function saveFilterOptions(
  options: FilterOptions,
): Promise<boolean> {
  return safeStorageOperation(
    async () => {
      // Validate options before saving
      const validatedOptions = validateFilterOptions(options);
      if (!validatedOptions) {
        console.error("Invalid filter options provided for saving");
        return false;
      }

      // Check if we have storage permission
      const hasPermission = await hasStoragePermission();
      if (!hasPermission) {
        console.log(
          "Storage permission not granted, cannot save filter options",
        );
        return false;
      }

      // Save filter options to Chrome storage
      await chrome.storage.local.set({
        [FILTER_OPTIONS_STORAGE_KEY]: validatedOptions,
      });
      console.log("Filter options saved to storage:", validatedOptions);
      return true;
    },
    false,
    "saveFilterOptions",
  );
}

/**
 * Migrates old filter data format to new format (if needed)
 */
export async function migrateFilterOptions(): Promise<void> {
  return safeStorageOperation(
    async () => {
      const hasPermission = await hasStoragePermission();
      if (!hasPermission) {
        return;
      }

      // Get all storage data to check for old format
      const allData = await chrome.storage.local.get();

      // Check for old filter option keys (if any existed in previous versions)
      const oldKeys = Object.keys(allData).filter(
        (key) => key.startsWith("filter_") || key.includes("download_option"),
      );

      if (oldKeys.length > 0) {
        console.log("Found old filter option format, migrating...");

        // Remove old keys
        await chrome.storage.local.remove(oldKeys);

        // Set default options in new format
        await chrome.storage.local.set({
          [FILTER_OPTIONS_STORAGE_KEY]: DEFAULT_FILTER_OPTIONS,
        });

        console.log("Migration completed");
      }
    },
    undefined,
    "migrateFilterOptions",
  );
}

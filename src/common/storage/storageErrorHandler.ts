import { FilterOptions, DEFAULT_FILTER_OPTIONS } from "../../types/filterTypes";

export enum StorageErrorType {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",
  STORAGE_UNAVAILABLE = "STORAGE_UNAVAILABLE",
  CORRUPTION = "CORRUPTION",
  UNKNOWN = "UNKNOWN",
}

export interface StorageError {
  type: StorageErrorType;
  message: string;
  originalError?: Error;
  recoverable: boolean;
}

/**
 * Analyzes Chrome storage errors and categorizes them
 */
export function analyzeStorageError(error: any): StorageError {
  const errorMessage = error?.message || error?.toString() || "Unknown error";

  // Permission denied errors
  if (errorMessage.includes("permission") || errorMessage.includes("denied")) {
    return {
      type: StorageErrorType.PERMISSION_DENIED,
      message: "Storage permission not granted",
      originalError: error,
      recoverable: true,
    };
  }

  // Quota exceeded errors
  if (errorMessage.includes("quota") || errorMessage.includes("exceeded")) {
    return {
      type: StorageErrorType.QUOTA_EXCEEDED,
      message: "Storage quota exceeded",
      originalError: error,
      recoverable: false,
    };
  }

  // Storage unavailable errors
  if (
    errorMessage.includes("unavailable") ||
    errorMessage.includes("disabled")
  ) {
    return {
      type: StorageErrorType.STORAGE_UNAVAILABLE,
      message: "Chrome storage is unavailable",
      originalError: error,
      recoverable: false,
    };
  }

  // Data corruption errors
  if (errorMessage.includes("corrupt") || errorMessage.includes("invalid")) {
    return {
      type: StorageErrorType.CORRUPTION,
      message: "Stored data is corrupted",
      originalError: error,
      recoverable: true,
    };
  }

  // Unknown errors
  return {
    type: StorageErrorType.UNKNOWN,
    message: errorMessage,
    originalError: error,
    recoverable: false,
  };
}

/**
 * Attempts to recover from storage errors
 */
export async function recoverFromStorageError(
  error: StorageError,
  fallbackOptions?: FilterOptions,
): Promise<FilterOptions> {
  console.warn("Storage error detected:", error);

  switch (error.type) {
    case StorageErrorType.PERMISSION_DENIED:
      // Use fallback options or defaults
      console.log("Using fallback options due to permission denial");
      return fallbackOptions || DEFAULT_FILTER_OPTIONS;

    case StorageErrorType.CORRUPTION:
      // Clear corrupted data and use defaults
      try {
        await chrome.storage.local.remove(["webPageDownloader_filterOptions"]);
        console.log("Cleared corrupted storage data");
      } catch (clearError) {
        console.error("Failed to clear corrupted data:", clearError);
      }
      return fallbackOptions || DEFAULT_FILTER_OPTIONS;

    case StorageErrorType.QUOTA_EXCEEDED:
      // Try to clear old data and use defaults
      try {
        // Clear all extension data except user ID
        const allData = await chrome.storage.local.get();
        const keysToRemove = Object.keys(allData);
        if (keysToRemove.length > 0) {
          await chrome.storage.local.remove(keysToRemove);
          console.log("Cleared storage to free up space");
        }
      } catch (clearError) {
        console.error("Failed to clear storage:", clearError);
      }
      return fallbackOptions || DEFAULT_FILTER_OPTIONS;

    case StorageErrorType.STORAGE_UNAVAILABLE:
    case StorageErrorType.UNKNOWN:
    default:
      // Use fallback options
      return fallbackOptions || DEFAULT_FILTER_OPTIONS;
  }
}

/**
 * Validates filter options data integrity
 */
export function validateFilterOptions(data: any): FilterOptions | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const requiredKeys: (keyof FilterOptions)[] = [
    "downloadHTML",
    "downloadImages",
    "downloadLinks",
    "downloadAssets",
    "downloadContentAsText",
    "downloadDocuments",
    "singleFile",
  ];

  // Check if all required keys exist and are booleans
  for (const key of requiredKeys) {
    if (!(key in data) || typeof data[key] !== "boolean") {
      console.warn(`Invalid filter option: ${key}`);
      return null;
    }
  }

  return data as FilterOptions;
}

/**
 * Safe storage operation wrapper with error handling
 */
export async function safeStorageOperation<T>(
  operation: () => Promise<T>,
  fallback: T,
  operationName: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const storageError = analyzeStorageError(error);
    console.error(`Storage operation '${operationName}' failed:`, storageError);

    // Log error for debugging
    if (storageError.originalError) {
      console.error("Original error:", storageError.originalError);
    }

    return fallback;
  }
}

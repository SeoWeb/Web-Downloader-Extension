/**
 * Memory Management Configuration for WebsiteDownloader Extension
 * Defines limits and thresholds for memory usage to prevent browser crashes
 */

import { adaptiveMemoryManager } from "./AdaptiveMemoryManager";

export interface MemoryLimitsConfig {
  // Maximum total memory usage for the extension (in bytes)
  MAX_TOTAL_MEMORY_USAGE: number;

  // Maximum size for individual resources (in bytes)
  MAX_RESOURCE_SIZE: number;

  // Maximum concurrent requests allowed
  MAX_CONCURRENT_REQUESTS: number;

  // Maximum ZIP file size before forcing streaming (in bytes)
  MAX_ZIP_SIZE: number;

  // Maximum HTML content size before forcing compression (in bytes)
  MAX_HTML_CONTENT_SIZE: number;

  // Memory threshold at which to start cleanup (percentage of max)
  CLEANUP_THRESHOLD: number;

  // Memory threshold at which to pause downloads (percentage of max)
  PAUSE_THRESHOLD: number;

  // Interval between memory checks (in milliseconds)
  MEMORY_CHECK_INTERVAL: number;

  // Maximum age for cached blobs before cleanup (in milliseconds)
  MAX_BLOB_AGE: number;

  // Garbage collection hint interval (in milliseconds)
  GC_HINT_INTERVAL: number;
}

/**
 * Default memory limits configuration
 * These values are tuned for Chrome extensions with service workers
 * Note: HTML content size is now dynamically calculated using AdaptiveMemoryManager
 */
export const DEFAULT_MEMORY_LIMITS: MemoryLimitsConfig = {
  // 500MB total memory limit - conservative for service workers
  MAX_TOTAL_MEMORY_USAGE: 500 * 1024 * 1024,

  // 50MB per resource - prevents single large files from exhausting memory
  MAX_RESOURCE_SIZE: 50 * 1024 * 1024,

  // 10 concurrent requests to limit memory pressure
  MAX_CONCURRENT_REQUESTS: 10,

  // 200MB ZIP size limit - forces streaming for large archives
  MAX_ZIP_SIZE: 200 * 1024 * 1024,

  // HTML content limit is now dynamically calculated using AdaptiveMemoryManager
  // This fallback value is only used if AdaptiveMemoryManager fails
  get MAX_HTML_CONTENT_SIZE(): number {
    try {
      return adaptiveMemoryManager.calculateSafeHtmlLimit();
    } catch {
      return 10 * 1024 * 1024; // 10MB fallback
    }
  },

  // Start cleanup at 75% memory usage
  CLEANUP_THRESHOLD: 0.75,

  // Pause downloads at 85% memory usage
  PAUSE_THRESHOLD: 0.85,

  // Check memory every 5 seconds during active downloads
  MEMORY_CHECK_INTERVAL: 5000,

  // Clean up blobs after 30 minutes
  MAX_BLOB_AGE: 30 * 60 * 1000,

  // Suggest garbage collection every 2 minutes
  GC_HINT_INTERVAL: 2 * 60 * 1000,
};

/**
 * Resource-specific size limits (in bytes)
 */
export const RESOURCE_SIZE_LIMITS = {
  // Images can be larger but still reasonable
  IMAGE: 20 * 1024 * 1024, // 20MB

  // Videos and audio files should be streamed
  VIDEO: 100 * 1024 * 1024, // 100MB
  AUDIO: 50 * 1024 * 1024, // 50MB

  // Text files should be relatively small
  CSS: 5 * 1024 * 1024, // 5MB
  JS: 10 * 1024 * 1024, // 10MB
  HTML: 10 * 1024 * 1024, // 10MB

  // Documents can be moderate size
  PDF: 25 * 1024 * 1024, // 25MB
  DOC: 15 * 1024 * 1024, // 15MB

  // Archives should be streamed
  ZIP: 50 * 1024 * 1024, // 50MB
  TAR: 50 * 1024 * 1024, // 50MB

  // Default limit for unknown types
  DEFAULT: 10 * 1024 * 1024, // 10MB
};

/**
 * Memory pressure levels
 */
export enum MemoryPressureLevel {
  LOW = "low", // < 50% memory usage
  MEDIUM = "medium", // 50-75% memory usage
  HIGH = "high", // 75-85% memory usage
  CRITICAL = "critical", // > 85% memory usage
}

/**
 * Error messages for memory-related failures
 */
export const MEMORY_ERROR_MESSAGES = {
  RESOURCE_TOO_LARGE: (url: string, size: number, limit: number) =>
    `Resource too large: ${url} (${Math.round(size / 1024 / 1024)}MB exceeds ${Math.round(limit / 1024 / 1024)}MB limit)`,

  MEMORY_LIMIT_EXCEEDED: (used: number, limit: number) =>
    `Memory limit exceeded: ${Math.round(used / 1024 / 1024)}MB used of ${Math.round(limit / 1024 / 1024)}MB limit`,

  CONCURRENT_LIMIT_EXCEEDED: (current: number, limit: number) =>
    `Too many concurrent requests: ${current} active (limit: ${limit})`,

  HTML_TOO_LARGE: (size: number, limit: number) =>
    `HTML content too large: ${Math.round(size / 1024 / 1024)}MB exceeds ${Math.round(limit / 1024 / 1024)}MB limit`,

  ZIP_TOO_LARGE: (size: number, limit: number) =>
    `ZIP archive too large: ${Math.round(size / 1024 / 1024)}MB exceeds ${Math.round(limit / 1024 / 1024)}MB limit`,

  MEMORY_CLEANUP_FAILED: "Failed to cleanup memory resources",

  INSUFFICIENT_MEMORY: "Insufficient memory available for download",
};

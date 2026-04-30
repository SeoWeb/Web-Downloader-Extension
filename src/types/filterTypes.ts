/**
 * Filter options interface for download preferences
 */
export interface FilterOptions {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadDocuments: boolean;
  singleFile: boolean;
  
  // Full scraping options for linked pages
  downloadLinksFullScraping?: boolean; // Enable full scraping (default: false)
  linkedPagesMaxCount?: number; // Default: 200, Max: 500
  linkedPagesDelay?: number; // Default: 500ms (delay between page loads)
  linkedPagesIncludeExternal?: boolean; // Default: false
  linkedPagesTimeout?: number; // Default: 30000ms (per page)

  alwaysAskWhereToSave?: boolean; // Default: true

  // Internal flag: force local mode for this download even when VITE_SERVER_URL
  // is set. Used by SERVER_LOCAL_FALLBACK to rerun in local mode (task 13.2).
  _forceLocal?: boolean;
}


/**
 * Default filter options matching current hardcoded values
 */
export const DEFAULT_FILTER_OPTIONS: FilterOptions = {
  downloadHTML: true,
  downloadImages: true,
  downloadLinks: false,
  downloadAssets: true,
  downloadContentAsText: false,
  downloadDocuments: true,
  singleFile: false,
  alwaysAskWhereToSave: true,
};

/**
 * Storage key for filter options in Chrome storage
 */
export const FILTER_OPTIONS_STORAGE_KEY = "webPageDownloader_filterOptions";

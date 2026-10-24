/**
 * Filter options interface for download preferences
 */
export interface FilterOptions {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadContentAsMarkdown?: boolean; // Default: false (server-side conversion)
  downloadDocuments: boolean;
  singleFile: boolean;

  // Full scraping options for linked pages
  downloadLinksFullScraping?: boolean; // Enable full scraping (default: false)
  linkedPagesMaxCount?: number; // Default: 200, Max: 500
  linkedPagesDelay?: number; // Default: 500ms (delay between page loads)
  linkedPagesIncludeExternal?: boolean; // Default: false
  linkedPagesTimeout?: number; // Default: 30000ms (per page)

  alwaysAskWhereToSave?: boolean; // Default: true
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
  downloadContentAsMarkdown: false,
  downloadDocuments: true,
  singleFile: false,
  alwaysAskWhereToSave: true,
};

/**
 * Storage key for filter options in Chrome storage
 */
export const FILTER_OPTIONS_STORAGE_KEY = "webPageDownloader_filterOptions";

/**
 * Whether the current selection is a text-only download
 * (text-native-downloads D7): HTML is off and at least one text format
 * is on. In this mode the images/assets/documents/single-file toggles
 * are inapplicable — the UI disables them with a hint and they must not
 * affect the outgoing download options.
 */
export function isTextOnlyDownload(options: FilterOptions): boolean {
  return (
    options.downloadHTML === false &&
    (options.downloadContentAsMarkdown === true ||
      options.downloadContentAsText === true)
  );
}

/**
 * Neutralize the options that are inapplicable to text-only downloads so
 * they cannot enable conflicting behavior in the outgoing download
 * options (text-native-downloads D7). Returned unchanged when the
 * selection is not text-only. The stored user preferences are left
 * untouched — the UI keeps showing them (disabled) and they are honored
 * again once HTML is re-enabled.
 */
export function normalizeTextOnlyOptions(
  options: FilterOptions,
): FilterOptions {
  if (!isTextOnlyDownload(options)) {
    return options;
  }
  return {
    ...options,
    downloadImages: false,
    downloadLinks: false,
    downloadAssets: false,
    downloadDocuments: false,
    singleFile: false,
  };
}

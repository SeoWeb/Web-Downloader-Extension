import { API_URLS } from "../apiConstants";

export interface AnalyticsSettings {
  html: 0 | 1;
  images: 0 | 1;
  links: 0 | 1;
  assets: 0 | 1;
  documents: 0 | 1;
  content: 0 | 1;
  single_file: 0 | 1;
}

export interface AnalyticsPayload {
  user_id: number;
  website: string;
  settings: AnalyticsSettings;
}

export interface DownloadOptions {
  downloadHTML: boolean;
  downloadImages: boolean;
  downloadLinks: boolean;
  downloadAssets: boolean;
  downloadContentAsText: boolean;
  downloadDocuments: boolean;
  singleFile: boolean;
}

/**
 * Converts download options to analytics settings format
 */
export function convertDownloadOptionsToAnalytics(
  options: DownloadOptions,
): AnalyticsSettings {
  return {
    html: options.downloadHTML ? 1 : 0,
    images: options.downloadImages ? 1 : 0,
    links: options.downloadLinks ? 1 : 0,
    assets: options.downloadAssets ? 1 : 0,
    documents: options.downloadDocuments ? 1 : 0,
    content: options.downloadContentAsText ? 1 : 0,
    single_file: options.singleFile ? 1 : 0,
  };
}

/**
 * Sends analytics data to the server
 */
export async function sendAnalytics(
  payload: AnalyticsPayload,
): Promise<boolean> {
  try {
    console.log("Sending analytics data:", payload);

    const response = await fetch(API_URLS.ANALYTICS, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return false;
    }

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Tracks a download event with user ID, website, and settings
 */
export async function trackDownload(
  userId: number,
  website: string,
  downloadOptions: DownloadOptions,
): Promise<boolean> {
  const settings = convertDownloadOptionsToAnalytics(downloadOptions);

  const payload: AnalyticsPayload = {
    user_id: userId,
    website,
    settings,
  };

  return await sendAnalytics(payload);
}

/**
 * Extracts a clean website URL for analytics (removes query params, fragments)
 */
export function cleanWebsiteUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  } catch (error) {
    return url;
  }
}

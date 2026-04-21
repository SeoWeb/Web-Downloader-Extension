/**
 * Linked Page Scraper
 * 
 * Manages sequential scraping of linked pages by navigating the active tab to each URL,
 * capturing the full DOM after JavaScript execution, and downloading all assets.
 * 
 * Key architectural decision: Uses sequential same-tab navigation instead of hidden tabs
 * to ensure reliable rendering, proper lazy loading, and consistent asset capture.
 */

import { IStorageAdapter } from "./storage/storage-adapter";
import { AssetRegistry } from "./asset-registry";
import { getResources } from "./resources";
import { convertHtml } from "./htmlUtils";
import { addCssFiles, addJsFiles, addImageFiles } from "./fileHandlers";
import { fixFilename } from "./urlUtils";

// Global image filename map shared across main page and all linked pages
let globalImageFilenameMap = new Map<string, string>();

/**
 * Set the global image filename map (from main page download)
 * so linked pages can reference already-downloaded images with correct filenames.
 */
export function setGlobalImageFilenameMap(map: Map<string, string>) {
  globalImageFilenameMap = map;
}

export interface LinkedPageJob {
  url: string;
  depth: number; // For future recursive crawling support
  parentUrl: string;
  status: "queued" | "processing" | "completed" | "failed";
}

export interface ScrapedPageData {
  html: string;
  url: string;
  finalUrl: string; // After redirects
  assets: {
    images: string[];
    css: string[];
    js: string[];
    documents: string[];
  };
}

export interface LinkedPageScraperOptions {
  maxPages?: number; // Default: 50, Max: 200
  delayBetweenPages?: number; // Default: 500ms
  includeExternal?: boolean; // Default: false
  pageTimeout?: number; // Default: 30000ms
}

export class LinkedPageScraper {
  private queue: LinkedPageJob[] = [];
  private assetRegistry: AssetRegistry;
  private originalTabUrl: string = "";
  private options: Required<LinkedPageScraperOptions>;
  private successCount: number = 0;
  private failCount: number = 0;
  private isPaused: boolean = false;
  private isStopped: boolean = false;
  private resumePromise: Promise<void> | null = null;
  private resumeResolve: (() => void) | null = null;

  constructor(
    assetRegistry: AssetRegistry,
    options: LinkedPageScraperOptions = {},
  ) {
    this.assetRegistry = assetRegistry;
    this.options = {
      maxPages: options.maxPages ?? 50,
      delayBetweenPages: options.delayBetweenPages ?? 500,
      includeExternal: options.includeExternal ?? false,
      pageTimeout: options.pageTimeout ?? 30000,
    };
  }

  pause() {
    if (!this.isPaused) {
      this.isPaused = true;
      this.resumePromise = new Promise((resolve) => {
        this.resumeResolve = resolve;
      });
    }
  }

  resume() {
    if (this.isPaused && this.resumeResolve) {
      this.isPaused = false;
      this.resumeResolve();
      this.resumePromise = null;
      this.resumeResolve = null;
    }
  }

  stop() {
    this.isStopped = true;
    // If paused, resume so loop can exit
    if (this.isPaused) {
      this.resume();
    }
  }

  /**
   * Add a URL to the scraping queue
   */
  async addToQueue(job: LinkedPageJob): Promise<void> {
    // Check for external links if option is disabled
    if (!this.options.includeExternal) {
      if (this.isExternalLink(job.url, job.parentUrl)) {
        return;
      }
    }

    // Check if we've reached the max page limit
    if (this.queue.length >= this.options.maxPages) {
      return;
    }

    // Check if URL is a non-HTML resource based on extension
    if (this.isNonHtmlResource(job.url)) {
      return;
    }

    // Check if URL is already in queue
    if (this.queue.some((j) => j.url === job.url)) {
      return;
    }

    this.queue.push(job);
  }

  /**
   * Check if a link is external (different hostname)
   */
  private isExternalLink(url: string, baseUrl: string): boolean {
    try {
      const urlObj = new URL(url);
      const baseObj = new URL(baseUrl);
      
      // Compare hostnames (case insensitive)
      return urlObj.hostname.toLowerCase() !== baseObj.hostname.toLowerCase();
    } catch (e) {
      // If URL parsing fails, treat as external to be safe
      return true;
    }
  }

  /**
   * Check if a URL points to a non-HTML resource based on extension
   */
  private isNonHtmlResource(url: string): boolean {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      // List of extensions to exclude from page scraping
      const excludedExtensions = [
        ".pdf", ".zip", ".rar", ".7z", ".tar", ".gz",
        ".exe", ".dmg", ".iso", ".bin",
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico",
        ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".webm",
        ".css", ".js", ".json", ".xml", ".txt", ".csv",
        ".stl", ".obj", ".3mf", ".fbx", ".dae", ".step", ".stp", ".iges", ".igs", ".dxf", ".dwg", ".gcode"
      ];
      
      return excludedExtensions.some(ext => pathname.endsWith(ext));
    } catch (e) {
      return false;
    }
  }

  /**
   * Process all queued pages sequentially
   */
  async processQueue(
    tabId: number,
    storage: IStorageAdapter,
    sendMessage: (message: string | { key: string; options?: any }) => void,
  ): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      this.originalTabUrl = tab.url || "";
    } catch {
      // Ignore
    }

    // Using storage adapter directly

    for (let i = 0; i < this.queue.length; i++) {
      // Check stop flag
      if (this.isStopped) {
        sendMessage("Scraping stopped by user");
        break;
      }

      // Check pause flag
      if (this.isPaused) {
        sendMessage({ key: "status.scraperPaused" });
        await this.resumePromise;
        if (this.isStopped) break; // Check again after resume
      }

      const job = this.queue[i];

      sendMessage({
        key: "status.linkedPageProgress",
        options: { current: i + 1, total: this.queue.length, isPaused: this.isPaused },
      });

      try {
        job.status = "processing";

        const scrapedData = await this.scrapeLinkedPage(
          tabId,
          job.url,
          storage,
          sendMessage,
        );

        // Save the HTML to the pages folder
        const filename = this.generateFilename(scrapedData.finalUrl);
        await storage.addFile(`pages/${filename}`, scrapedData.html, "text/html");

        job.status = "completed";
        this.successCount++;
      } catch (error) {
        job.status = "failed";
        this.failCount++;
        sendMessage(`Failed to scrape: ${job.url}`);
      }

      // Add delay between pages to avoid rate limiting
      if (i < this.queue.length - 1 && this.options.delayBetweenPages > 0) {
        // We can split delay into smaller chunks to check for pause/stop during delay?
        // Or just await delay. For 500ms it doesn't matter much.
        await this.delay(this.options.delayBetweenPages);
      }
    }

    // Restore original page
    await this.restoreOriginalPage(tabId);

    // Send completion message
    sendMessage({
      key: "status.linkedPagesComplete",
      options: { succeeded: this.successCount, failed: this.failCount },
    });
  }

  /**
   * Scrape a single linked page
   */
  private async scrapeLinkedPage(
    tabId: number,
    url: string,
    storage: IStorageAdapter,
    sendMessage: (message: string | { key: string; options?: any }) => void,
  ): Promise<ScrapedPageData> {
    // Navigate to the page and wait for it to load
    const finalUrl = await this.navigateAndWait(tabId, url);

    // Execute scroll script for lazy-loaded content
    await this.scrollPageForLazyLoading(tabId);

    // Capture the DOM
    const html = await this.capturePageDOM(tabId);

    // Extract resources
    const resources = getResources(html);

    // Download assets (checking registry first to avoid duplicates)
    const localImageMap = await this.downloadAssets(resources, storage, finalUrl, sendMessage);

    // Build a combined filename map: global (main page + previous linked pages) + local (this page)
    // This ensures images already downloaded by the main page have correct filenames
    const combinedImageMap = new Map<string, string>(globalImageFilenameMap);
    for (const [key, value] of localImageMap) {
      combinedImageMap.set(key, value);
    }

    // Convert HTML with proper link rewriting (pages are in pages/ folder, assets are at root level)
    const convertedHtml = convertHtml(html, finalUrl, "../", combinedImageMap);

    return {
      html: convertedHtml,
      url,
      finalUrl,
      assets: {
        images: resources.images,
        css: resources.css,
        js: resources.js,
        documents: resources.documents,
      },
    };
  }

  /**
   * Navigate to a URL and wait for the page to load
   */
  private async navigateAndWait(
    tabId: number,
    url: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Navigation timeout after ${this.options.pageTimeout}ms`));
      }, this.options.pageTimeout);

      const listener = (
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab,
      ) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          cleanup();
          resolve(tab.url || url);
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
      };

      chrome.tabs.onUpdated.addListener(listener);

      // Navigate to the URL
      chrome.tabs.update(tabId, { url }).catch((error) => {
        cleanup();
        reject(error);
      });
    });
  }

  /**
   * Capture the page DOM after JavaScript execution
   */
  private async capturePageDOM(tabId: number): Promise<string> {
    const timeout = 10000; // 10 second timeout for DOM capture

    const result = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.documentElement.outerHTML,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("DOM capture timeout")),
          timeout,
        )
      ),
    ]);

    if (!result || result.length === 0 || !result[0].result) {
      throw new Error("Failed to capture DOM");
    }

    return result[0].result as string;
  }

  /**
   * Scroll the page to trigger lazy loading
   */
  private async scrollPageForLazyLoading(tabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          // Smooth scroll to bottom to trigger lazy loading
          const scrollHeight = document.documentElement.scrollHeight;
          const viewportHeight = window.innerHeight;
          const scrollSteps = Math.ceil(scrollHeight / viewportHeight);

          for (let i = 0; i < scrollSteps; i++) {
            window.scrollTo({
              top: (i + 1) * viewportHeight,
              behavior: "smooth",
            });
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          // Scroll back to top
          window.scrollTo({ top: 0, behavior: "smooth" });
          await new Promise((resolve) => setTimeout(resolve, 200));
        },
      });
    } catch {
      // Non-critical error, continue anyway
    }
  }

  /**
   * Download assets for a linked page, checking registry first.
   * Returns the image filename map for this page's newly downloaded images.
   */
  private async downloadAssets(
    resources: {
      css: string[];
      js: string[];
      images: string[];
      documents: string[];
    },
    storage: IStorageAdapter,
    pageUrl: string,
    sendMessage: (message: string | { key: string; options?: any }) => void,
  ): Promise<Map<string, string>> {
    const localImageFilenameMap = new Map<string, string>();

    // Filter out assets that are already downloaded
    const newCss = resources.css.filter((url) => {
      const fullUrl = new URL(url, pageUrl).href;
      return !this.assetRegistry.has(fullUrl);
    });

    const newJs = resources.js.filter((url) => {
      const fullUrl = new URL(url, pageUrl).href;
      return !this.assetRegistry.has(fullUrl);
    });

    const newImages = resources.images.filter((url) => {
      const fullUrl = new URL(url, pageUrl).href;
      return !this.assetRegistry.has(fullUrl);
    });

    // Download new assets
    if (newCss.length > 0) {
      await addCssFiles(newCss, storage, pageUrl, sendMessage);
    }

    if (newJs.length > 0) {
      await addJsFiles(newJs, storage, pageUrl, sendMessage);
    }

    if (newImages.length > 0) {
      const downloadedMap = await addImageFiles(newImages, storage, pageUrl, sendMessage);
      // Merge into local and global maps
      for (const [key, value] of downloadedMap) {
        localImageFilenameMap.set(key, value);
        globalImageFilenameMap.set(key, value);
      }
    }

    // Register all assets (including ones we skipped)
    for (const url of resources.css) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(fullUrl, `assets/css/${fixFilename(url)}`, 0);
      }
    }

    for (const url of resources.js) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(fullUrl, `assets/js/${fixFilename(url)}`, 0);
      }
    }

    for (const url of resources.images) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(fullUrl, `assets/images/${fixFilename(url)}`, 0);
      }
    }

    return localImageFilenameMap;
  }

  /**
   * Restore the original page after scraping
   */
  private async restoreOriginalPage(tabId: number): Promise<void> {
    if (!this.originalTabUrl) {
      return;
    }

    try {
      await chrome.tabs.update(tabId, { url: this.originalTabUrl });
    } catch {
      // Non-critical error, continue anyway
    }
  }

  /**
   * Generate a safe filename from a URL
   */
  private generateFilename(url: string): string {
    try {
      const urlObj = new URL(url);
      let filename = urlObj.pathname.split("/").pop() || "page";

      // Remove query params and fragments
      filename = filename.split("?")[0].split("#")[0];

      // Ensure .html extension
      if (!filename.endsWith(".html")) {
        filename = `${filename}.html`;
      }

      return fixFilename(filename);
    } catch {
      return "page.html";
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get scraping statistics
   */
  getStats() {
    return {
      total: this.queue.length,
      succeeded: this.successCount,
      failed: this.failCount,
      pending: this.queue.filter((j) => j.status === "queued").length,
    };
  }
}

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
import { addCssFiles, addJsFiles, addImageFiles, addDocumentFiles } from "./fileHandlers";
import { fixFilename } from "./urlUtils";
import { serverClient, HttpError } from "./server-client";

/**
 * Generate a short hash suffix from a URL for filename collision avoidance.
 * Returns a 4-character alphanumeric string derived from the URL.
 * Matches the algorithm exported from link-converter.ts but inlined here
 * to avoid transitive linkedom dependency in test environments.
 */
function shortHash(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 4).padEnd(4, "0");
}

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
  /**
   * Chunked representation of the HTML body content for server-mode streaming.
   * Each chunk is a self-contained serialization of a group of top-level body children,
   * wrapped in the page skeleton. In local mode this is always a single-element array
   * containing the full HTML. In server mode the caller uploads each chunk separately
   * via uploadHtmlChunk(pageType: 'linked') to avoid holding the entire page DOM in
   * extension memory at once. (C3 fix: defines the linked page DOM chunking mechanism.)
   */
  htmlChunks: string[];
  url: string;
  finalUrl: string; // After redirects
  /** (12.11) Image filename map for this page's newly downloaded images.
   * Used to build incremental filename map uploads in server mode. */
  localImageMap: Map<string, string>;
  /** Combined image filename map (global + local) for link conversion in local mode. */
  combinedImageMap: Map<string, string>;
  /** Body text extracted from the page via getResources().text.
   * Used to accumulate content text across all linked pages. */
  text: string;
  assets: {
    images: string[];
    css: string[];
    js: string[];
    documents: string[];
  };
}

export interface LinkedPageScraperOptions {
  maxPages?: number; // Default: 50, Max: 200
  delayBetweenPages?: number; // Default: 200ms
  includeExternal?: boolean; // Default: false
  pageTimeout?: number; // Default: 30000ms
  /** (12.10) Server session ID — when set, linked page HTML chunks are uploaded
   * to the server with pageType: "linked" and pageUrl metadata instead of
   * being stored locally. Also triggers incremental filename map uploads (12.11). */
  serverSessionId?: string;
}

export class LinkedPageScraper {
  private queue: LinkedPageJob[] = [];
  private assetRegistry: AssetRegistry;
  private originalTabUrl: string = "";
  private options: Required<Omit<LinkedPageScraperOptions, 'serverSessionId'>> & { serverSessionId?: string };
  private successCount: number = 0;
  private failCount: number = 0;
  private isPaused: boolean = false;
  private isStopped: boolean = false;
  private resumePromise: Promise<void> | null = null;
  private resumeResolve: (() => void) | null = null;
  /** When true, extract and accumulate body text from linked pages. */
  private extractText: boolean = true;

  constructor(
    assetRegistry: AssetRegistry,
    options: LinkedPageScraperOptions = {},
  ) {
    this.assetRegistry = assetRegistry;
    this.options = {
      maxPages: options.maxPages ?? 50,
      delayBetweenPages: options.delayBetweenPages ?? 200,
      includeExternal: options.includeExternal ?? false,
      pageTimeout: options.pageTimeout ?? 30000,
      serverSessionId: options.serverSessionId,
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
   * Set whether to extract body text from linked pages.
   * When false, text extraction is skipped (for downloadContentAsText disabled).
   */
  setExtractText(enabled: boolean) {
    this.extractText = enabled;
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
   * Process all queued pages sequentially.
   * Returns accumulated body text from all linked pages, with page-URL delimiters.
   */
  async processQueue(
    tabId: number,
    storage: IStorageAdapter,
    sendMessage: (message: string | { key: string; options?: any }) => void,
  ): Promise<string> {
    if (this.queue.length === 0) {
      return "";
    }

    let accumulatedText = "";

    try {
      const tab = await chrome.tabs.get(tabId);
      this.originalTabUrl = tab.url || "";
    } catch {
      // Ignore
    }

    // Track used filenames for collision avoidance in local mode.
    // When two linked pages share the same base filename (e.g. /about/team
    // and /contact/team both → team.html), the second gets a short hash
    // suffix (e.g. team-a1b2.html), matching the server assembler logic.
    const usedFilenames = new Set<string>();
    // Maps finalUrl → collision-resolved filename (e.g. "https://example.com/contact/team" → "team-a1b2.html")
    const pageFilenameMap = new Map<string, string>();
    // Collect raw (un-link-converted) HTML + metadata for local mode so we
    // can convert all links with the full collision map after scraping completes.
    const localModePages: Array<{ finalUrl: string; filename: string; rawHtml: string; combinedImageMap: Map<string, string> }> = [];

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

        if (this.options.serverSessionId) {
          // (12.10) Server mode: upload HTML chunks with pageType "linked"
          // and pageUrl metadata. All chunks for a page are uploaded
          // concurrently to reduce latency while preserving per-chunk
          // scroll indices for correct server-side reassembly.
          const sessionId = this.options.serverSessionId;
          await Promise.all(
            scrapedData.htmlChunks.map((chunk, ci) =>
              serverClient.uploadHtmlChunk(
                sessionId,
                chunk,
                ci,
                "linked",
                scrapedData.finalUrl,
              ),
            ),
          );

          // (12.11) Upload incremental filename map after this linked page's
          // assets are downloaded. The delta map contains only the new entries
          // discovered for this linked page, ensuring the server always holds
          // an up-to-date mapping for URL conversion.
          const deltaMap: Record<string, string> = {};
          for (const [key, value] of scrapedData.localImageMap ?? []) {
            // Only include entries not already in the global map
            if (!globalImageFilenameMap.has(key)) {
              deltaMap[key] = value;
            }
          }
          if (Object.keys(deltaMap).length > 0) {
            await serverClient.uploadFilenameMap(this.options.serverSessionId, deltaMap);
          }
        } else {
          // Local mode: determine filename with collision handling.
          // Defer link conversion until all pages are scraped so that
          // cross-page links use the correct collision-resolved filenames.
          const baseFilename = this.generateFilename(scrapedData.finalUrl);
          let filename = baseFilename;
          if (usedFilenames.has(filename)) {
            // Collision — append short hash suffix (matches server assembler logic)
            const nameBase = baseFilename.replace(/\.html$/i, "");
            const hashSuffix = shortHash(scrapedData.finalUrl);
            filename = `${nameBase}-${hashSuffix}.html`;
          }
          usedFilenames.add(filename);
          pageFilenameMap.set(scrapedData.finalUrl, filename);

          // Store raw HTML for deferred link conversion
          localModePages.push({
            finalUrl: scrapedData.finalUrl,
            filename,
            rawHtml: scrapedData.html, // raw (un-link-converted) HTML
            combinedImageMap: scrapedData.combinedImageMap,
          });
        }

        job.status = "completed";
        this.successCount++;

        // Accumulate linked page text with page-URL delimiters
        if (this.extractText && scrapedData.text) {
          accumulatedText += `\n--- ${scrapedData.finalUrl} ---\n${scrapedData.text}`;
        }
      } catch (error) {
        // If this is a 413 session-full error, stop the scraper loop
        // immediately — further pages would also exceed the limit.
        const isSessionFull = error instanceof HttpError && error.statusCode === 413;
        if (isSessionFull) {
          job.status = "failed";
          this.failCount++;
          this.isStopped = true;
          break;
        }
        job.status = "failed";
        this.failCount++;
        sendMessage(`Failed to scrape: ${job.url}`);
      }

      // Add delay between pages to avoid rate limiting
      if (i < this.queue.length - 1 && this.options.delayBetweenPages > 0) {
        // We can split delay into smaller chunks to check for pause/stop during delay?
        // Or just await delay. For 200ms it doesn't matter much.
        await this.delay(this.options.delayBetweenPages);
      }
    }

    // Restore original page
    await this.restoreOriginalPage(tabId);

    // Local mode: now that all pages are scraped and the full pageFilenameMap
    // is built, convert links and save each page to storage. This ensures
    // cross-page links use collision-resolved filenames (e.g. a link from
    // page A to page B will use "team-a1b2.html" if B had a collision).
    for (const page of localModePages) {
      const convertedHtml = convertHtml(
        page.rawHtml, page.finalUrl, "../", page.combinedImageMap, pageFilenameMap,
      );
      await storage.addFile(`pages/${page.filename}`, convertedHtml, "text/html");
    }

    // Send completion message
    sendMessage({
      key: "status.linkedPagesComplete",
      options: { succeeded: this.successCount, failed: this.failCount },
    });

    return accumulatedText;
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

    // Capture the DOM. For server mode we capture in chunks to avoid holding
    // the entire page outerHTML as a single large string in extension memory.
    // For local mode we use the full single-string capture as before.
    const htmlChunks = await this.capturePageDOMChunks(tabId);
    const html = htmlChunks.join('');

    // Extract resources
    const resources = getResources(html);
    const pageText = resources.text;

    // (12.11) Download assets (checking registry first to avoid duplicates).
    // Returns the image filename map for this page's newly downloaded images.
    const localImageMap = await this.downloadAssets(resources, storage, finalUrl, sendMessage);

    // Build a combined filename map: global (main page + previous linked pages) + local (this page)
    const combinedImageMap = new Map<string, string>(globalImageFilenameMap);
    for (const [key, value] of localImageMap) {
      combinedImageMap.set(key, value);
    }

    if (this.options.serverSessionId) {
      // (12.10) Server mode: return raw HTML chunks (unconverted) — the
      // server handles URL conversion. The caller uploads each chunk
      // separately with pageType: "linked" and pageUrl.
      return {
        html,
        htmlChunks,
        url,
        finalUrl,
        localImageMap,
        combinedImageMap,
        text: pageText,
        assets: {
          images: resources.images,
          css: resources.css,
          js: resources.js,
          documents: resources.documents,
        },
      };
    }

    // Local mode: return raw (un-link-converted) HTML. Link conversion is
    // deferred to processQueue() so that all pages' cross-page links can
    // be resolved with the full collision-aware pageFilenameMap.
    return {
      html,
      htmlChunks: [html],
      url,
      finalUrl,
      localImageMap,
      combinedImageMap,
      text: pageText,
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
   * Capture the page DOM after JavaScript execution.
   * Returns the full outerHTML as a single string.
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
   * Capture the page DOM as an array of HTML chunk strings.
   *
   * Strategy: serialize top-level `<body>` children in batches until each batch
   * reaches the target chunk size (default 512 KB). Each chunk contains the page
   * skeleton (doctype + `<html><head>...</head><body>`) wrapping only that batch
   * of children, so each chunk is a valid, parseable HTML fragment.
   *
   * This avoids holding a single monolithic `outerHTML` string in the extension's
   * JS heap, which can spike memory for large linked pages. (C3 fix.)
   *
   * Falls back to a single-chunk capture if scripting fails or the body is empty.
   *
   * @param targetChunkBytes - Target uncompressed size per chunk (default 512 KB).
   */
  private async capturePageDOMChunks(
    tabId: number,
    targetChunkBytes: number = 512 * 1024,
  ): Promise<string[]> {
    const timeout = 15000;

    type ChunkResult = { skeleton: string; bodyChildren: string[] };

    const result = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Serialise each top-level body child individually so the caller can
          // batch them into target-sized chunks without parsing the full HTML.
          const skeleton = document.documentElement.outerHTML
            .replace(/<body[^>]*>[\s\S]*<\/body>/i, '<body></body>');
          const children: string[] = [];
          for (const child of Array.from(document.body.children)) {
            children.push((child as Element).outerHTML);
          }
          return { skeleton, bodyChildren: children } as { skeleton: string; bodyChildren: string[] };
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DOM chunk capture timeout")), timeout)
      ),
    ]);

    if (!result || result.length === 0 || !result[0].result) {
      // Fallback: single full outerHTML capture
      const html = await this.capturePageDOM(tabId);
      return [html];
    }

    const { skeleton, bodyChildren } = result[0].result as ChunkResult;

    if (bodyChildren.length === 0) {
      // Empty body — return the skeleton as a single chunk
      return [skeleton];
    }

    // Group children into target-sized chunks
    const chunks: string[] = [];
    let currentChildren: string[] = [];
    let currentSize = 0;

    // Extract the body open tag from the skeleton so we can reconstruct each chunk
    const bodyOpenMatch = skeleton.match(/<body[^>]*>/i);
    const bodyOpen = bodyOpenMatch ? bodyOpenMatch[0] : '<body>';
    const skeletonBeforeBody = skeleton.slice(0, skeleton.indexOf(bodyOpen));
    const skeletonAfterBody = '</body>' + skeleton.slice(skeleton.indexOf('</body>') + '</body>'.length);

    for (const child of bodyChildren) {
      currentChildren.push(child);
      currentSize += child.length;

      if (currentSize >= targetChunkBytes) {
        chunks.push(skeletonBeforeBody + bodyOpen + currentChildren.join('') + skeletonAfterBody);
        currentChildren = [];
        currentSize = 0;
      }
    }

    // Flush the last batch
    if (currentChildren.length > 0) {
      chunks.push(skeletonBeforeBody + bodyOpen + currentChildren.join('') + skeletonAfterBody);
    }

    return chunks.length > 0 ? chunks : [skeleton];
  }

  /**
   * Scroll the page to trigger lazy loading.
   *
   * Single adaptive pass: scrolls from top to bottom, re-checking
   * scrollHeight after each step. Continues scrolling when the page
   * grows (lazy content loads), and only stops after 3 consecutive
   * stable-height checks at the bottom. A settle delay after the
   * pass gives IntersectionObserver callbacks time to fire.
   *
   * The adaptive strategy stays within a budget derived from
   * `pageTimeout` (roughly 40% of the timeout), so the overall scrape
   * (navigation + scroll + capture) remains within bounds.
   */
  private async scrollPageForLazyLoading(tabId: number): Promise<void> {
    // Budget: use roughly 40% of pageTimeout for scrolling, leaving
    // the rest for navigation and DOM capture. Minimum 5 seconds.
    const scrollBudgetMs = Math.max(this.options.pageTimeout * 0.4, 5000);

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: async (budgetMs: number) => {
          const startTime = Date.now();
          const remaining = () => Math.max(0, budgetMs - (Date.now() - startTime));

          const viewportHeight = window.innerHeight;
          const buffer = 100; // 100px buffer for "at bottom" detection
          const maxIterations = 500; // Safety limit to prevent infinite scrolling
          const stabilityThreshold = 3; // Consecutive stable-height checks needed

          // --- Pass 1: adaptive scroll to bottom (300ms per step) ---
          {
            let iterations = 0;
            let lastScrollHeight = document.documentElement.scrollHeight;
            let stableCount = 0;
            let prevScrollY = window.scrollY;

            while (iterations < maxIterations && remaining() >= 300) {
              const currentScrollHeight = document.documentElement.scrollHeight;
              const currentScrollY = window.scrollY;

              // Detect layout shift: page jumped up (scrollY decreased)
              if (currentScrollY < prevScrollY - 10) {
                stableCount = 0;
              }
              prevScrollY = currentScrollY;

              // Check if page grew → reset stability counter
              if (currentScrollHeight > lastScrollHeight) {
                stableCount = 0;
                lastScrollHeight = currentScrollHeight;
              }

              // Check if at bottom
              const isAtBottom = currentScrollY + viewportHeight >= currentScrollHeight - buffer;
              if (isAtBottom) {
                stableCount++;
                if (stableCount >= stabilityThreshold) break;
              } else {
                stableCount = 0;
              }

              // Scroll down by one viewport
              window.scrollTo({
                top: currentScrollY + viewportHeight,
                behavior: "smooth",
              });
              await new Promise((resolve) => setTimeout(resolve, Math.min(300, remaining())));
              iterations++;
            }
          }

          // --- Single adaptive pass with settle delay ---
          // The adaptive while-loop above continues scrolling until the page
          // height is stable for 3 consecutive checks at the bottom, so a
          // second pass from the top is no longer needed. The settle delay
          // gives IntersectionObserver callbacks time to fire.
          const settleDelay = Math.min(800, remaining());
          if (settleDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, settleDelay));
          }

          // Scroll back to top
          window.scrollTo({ top: 0, behavior: "smooth" });
          await new Promise((resolve) => setTimeout(resolve, 200));
        },
        args: [scrollBudgetMs],
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

    const newDocuments = resources.documents.filter((url) => {
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

    if (newDocuments.length > 0) {
      await addDocumentFiles(newDocuments, storage, pageUrl, sendMessage);
    }

    // Register all assets (including ones we skipped)
    for (const url of resources.css) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(fullUrl, `styles/${fixFilename(url)}`, 0);
      }
    }

    for (const url of resources.js) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(fullUrl, `scripts/${fixFilename(url)}`, 0);
      }
    }

    for (const url of resources.images) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(fullUrl, `images/${fixFilename(url)}`, 0);
      }
    }

    for (const url of resources.documents) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(fullUrl, `documents/${fixFilename(url)}`, 0);
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

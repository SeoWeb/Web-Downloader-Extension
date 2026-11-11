/**
 * Linked Page Scraper
 *
 * Manages sequential scraping of linked pages by navigating the active tab to each URL,
 * capturing the full DOM after JavaScript execution, and downloading all assets.
 *
 * Key architectural decision: Uses sequential same-tab navigation instead of hidden tabs
 * to ensure reliable rendering, proper lazy loading, and consistent asset capture.
 */

import { IStorageAdapter } from "./storage/server-storage-adapter";
import { AssetRegistry, buildArchivePath } from "./asset-registry";
import { getResources } from "./resources";
import {
  addCssFiles,
  addJsFiles,
  addImageFiles,
  addDocumentFiles,
} from "./fileHandlers";
import { serverClient, HttpError } from "./server-client";
import type { DownloadContext } from "./download-state";
import { mergeFilenameMaps, type HandlerOptions } from "./download-processors";
import {
  writeScraperSnapshot,
  clearScraperSnapshot,
  truncateSnapshotQueues,
  SCRAPER_SNAPSHOT_VERSION,
  type LinkedScraperSnapshot,
  type ScraperSnapshotJob,
} from "./scraper-snapshot";
import {
  pauseCheckpoint,
  restoreCheckpointPhase,
  readCheckpoint,
} from "./download-checkpoint";

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
   * wrapped in the page skeleton. The caller uploads each chunk separately
   * via uploadHtmlChunk(pageType: 'linked') to avoid holding the entire page DOM in
   * extension memory at once.
   */
  htmlChunks: string[];
  url: string;
  finalUrl: string; // After redirects
  /** Filename map for this page's newly downloaded assets (images,
   * stylesheets, scripts, documents — raw reference AND absolute URL →
   * archive path). Used to build incremental filename map uploads. */
  localFilenameMap: Map<string, string>;
  /** Body text extracted from the page via getResources().text.
   * Uploaded per page via uploadPageContent right after the scrape
   * (multipage-download-fixes D4 — no whole-run accumulation). */
  text: string;
  assets: {
    images: string[];
    css: string[];
    js: string[];
    documents: string[];
  };
}

export interface LinkedPageScraperOptions {
  /** Maximum pages to scrape. Accepts 1–500; values outside the range are
   * clamped (default 50). The docstring previously claimed "Max: 200" while
   * any value was accepted — now the clamp makes the limit real (task 4.7). */
  maxPages?: number;
  delayBetweenPages?: number; // Default: 200ms
  includeExternal?: boolean; // Default: false
  pageTimeout?: number; // Default: 30000ms
  /** Server session ID — linked page HTML chunks are uploaded
   * to the server with pageType: "linked" and pageUrl metadata. */
  serverSessionId?: string;
  /**
   * Press-time download options snapshot (multipage-download-fixes D1).
   * Per-category asset gates for linked pages, mirroring the main page's
   * gates in download-core (images on downloadImages, css/js on
   * downloadAssets, documents on downloadDocuments). The snapshot is frozen
   * when the download starts — never re-read live mid-run. Defaults true so
   * existing constructions without the fields keep current behavior.
   */
  downloadImages?: boolean; // Default: true
  downloadAssets?: boolean; // Default: true
  downloadDocuments?: boolean; // Default: true
}

/** Hard bounds for the maxPages option (task 4.7). */
export const MIN_MAX_PAGES = 1;
export const MAX_MAX_PAGES = 500;
const DEFAULT_MAX_PAGES = 50;

/** Clamp maxPages into [1, 500]; NaN/non-finite falls back to the default. */
export function clampMaxPages(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.min(Math.max(Math.floor(value), MIN_MAX_PAGES), MAX_MAX_PAGES);
}

/**
 * (multipage-download-fixes D2 / task 4.1) Pause is TRUE and indefinite.
 * The former bounded watchdog (PAUSED_WATCHDOG_MS = 60 s) that self-stopped
 * a paused scraper has been REMOVED: a paused scraper blocks between-page
 * advancement indefinitely at the existing check sites and only an explicit
 * resume() or stop() lifts it. If the service worker dies while the pause is
 * held, the download parks (checkpoint phase `paused` + queue snapshot in
 * chrome.storage.session) instead of stopping — see persistPauseSnapshot and
 * resumeFromParkedScrape (download-core).
 */

/**
 * Normalize a URL for navigation-completion matching (D4 / task 4.1):
 * origin + path + query, hash-insensitive. Hash-only differences fire
 * during anchor scrolling and must not disqualify a completion. The query
 * is KEPT — paginated URLs that differ only in `?page=` are different
 * pages, and a stale completion from the previous page must not resolve
 * the wait.
 */
export function normalizeNavigationUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return raw;
  }
}

/**
 * (design D6 / tasks 6.1–6.2) Fire-and-forget panel push — local twin of
 * download-core's pushToPanelSafely (importing it directly would create a
 * module cycle: download-core imports this module).
 *
 * The injected `sendMessage` callback returns the panel-delivery promise
 * (messageWorker's addMessage → sendMessageToPanel), so when the side panel
 * is closed every push rejects with "Receiving end does not exist". Catch
 * and log those failures at debug level so a failed push never becomes an
 * unhandled rejection in the service worker and never affects the scrape
 * pipeline. A successful push behaves exactly as the bare call did.
 */
function pushToPanelSafely(
  sendMessage: (message: string | { key: string; options?: any }) => unknown,
  message: string | { key: string; options?: any },
): void {
  try {
    Promise.resolve(sendMessage(message)).catch((err) => {
      console.debug(
        "[LinkedPageScraper] panel push failed (ignored):",
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    console.debug(
      "[LinkedPageScraper] panel push failed (ignored):",
      err instanceof Error ? err.message : err,
    );
  }
}

export class LinkedPageScraper {
  private internalQueue: LinkedPageJob[] = [];
  private externalQueue: LinkedPageJob[] = [];

  private get combinedQueue(): LinkedPageJob[] {
    return [...this.internalQueue, ...this.externalQueue];
  }
  private assetRegistry: AssetRegistry;
  private originalTabUrl: string = "";
  private options: Required<
    Omit<LinkedPageScraperOptions, "serverSessionId">
  > & { serverSessionId?: string };
  private successCount: number = 0;
  private failCount: number = 0;
  private isPaused: boolean = false;
  private isStopped: boolean = false;
  private resumePromise: Promise<void> | null = null;
  private resumeResolve: (() => void) | null = null;
  /** (D2 / task 4.4) Checkpoint phase observed when the pause took effect —
   *  restored on resume/stop so upstream uploading/assembling transitions
   *  keep working. Null while no pause is held. */
  private prePauseCheckpointPhase: string | null = null;
  /** When true, extract and upload body text from linked pages
   *  (per-page streaming — multipage-download-fixes D4). */
  private extractText: boolean = true;
  /** Every URL this scraper intended to navigate to (dedup'd scrape set). */
  private scrapeUrls: Set<string> = new Set();
  /** The URL of the most recent navigation this scraper performed. */
  private lastNavigatedUrl: string = "";

  constructor(
    assetRegistry: AssetRegistry,
    options: LinkedPageScraperOptions = {},
  ) {
    this.assetRegistry = assetRegistry;
    this.options = {
      maxPages: clampMaxPages(options.maxPages),
      delayBetweenPages: options.delayBetweenPages ?? 200,
      includeExternal: options.includeExternal ?? false,
      pageTimeout: options.pageTimeout ?? 30000,
      serverSessionId: options.serverSessionId,
      // Asset-category gates default true (D1) — pre-existing constructions
      // without the fields keep the ungated behavior.
      downloadImages: options.downloadImages ?? true,
      downloadAssets: options.downloadAssets ?? true,
      downloadDocuments: options.downloadDocuments ?? true,
    };
  }

  /**
   * (multipage-download-fixes D2 / task 4.5) Re-spawn a scraper from a
   * persisted pause snapshot (resume-from-park). The returned scraper is
   * seeded with the same options, the same (never finalized) server session
   * id, the REMAINING queues, and the visited set — pages already processed
   * before the park are skipped, not re-scraped.
   *
   * Note the in-memory AssetRegistry from the pre-park run is gone (worker
   * death); asset dedup after a park falls back to the server's url_hash
   * dedup at storage time (design D2).
   */
  static fromSnapshot(
    snapshot: LinkedScraperSnapshot,
    assetRegistry: AssetRegistry,
  ): LinkedPageScraper {
    const o = snapshot.options;
    const scraper = new LinkedPageScraper(assetRegistry, {
      maxPages: o.maxPages,
      delayBetweenPages: o.delayBetweenPages,
      includeExternal: o.includeExternal,
      pageTimeout: o.pageTimeout,
      serverSessionId: snapshot.serverSessionId,
      downloadImages: o.downloadImages,
      downloadAssets: o.downloadAssets,
      downloadDocuments: o.downloadDocuments,
    });
    scraper.restoreFromSnapshot(snapshot);
    return scraper;
  }

  /**
   * Seed this scraper from a pause snapshot (see fromSnapshot). Restores the
   * remaining internal/external queues, the visited/processed set, the
   * counters, text-extraction mode, and the pre-pause checkpoint phase.
   */
  restoreFromSnapshot(snapshot: LinkedScraperSnapshot): void {
    for (const job of snapshot.internalQueue) {
      this.internalQueue.push({ ...job, status: "queued" });
      this.scrapeUrls.add(job.url);
    }
    for (const job of snapshot.externalQueue) {
      this.externalQueue.push({ ...job, status: "queued" });
      this.scrapeUrls.add(job.url);
    }
    // Visited (completed or failed) pages: added to the dedup scrape set so
    // they are never re-scraped and restoreOriginalPage's guard stays intact.
    for (const url of snapshot.visitedUrls) {
      this.scrapeUrls.add(url);
    }
    this.successCount = snapshot.successCount;
    this.failCount = snapshot.failCount;
    this.prePauseCheckpointPhase =
      snapshot.previousCheckpointPhase ?? "scraping";
    // (multipage-download-fixes D4 / task 3.2) The frozen press-time
    // extractText gate governs the resumed per-page text uploads too —
    // never re-read live (D1).
    this.extractText = snapshot.options.extractText;
    // Preserve the original tab URL so end-of-run restore + pause release
    // still know where the tab belongs.
    if (snapshot.tabUrl) {
      this.originalTabUrl = snapshot.tabUrl;
    }
  }

  /**
   * (multipage-download-fixes D2 / task 4.1) Pause the scraper. The pause
   * holds INDEFINITELY: the loop blocks at its between-page advancement
   * check until resume() or stop() is called — no watchdog self-stops it.
   * The state work (tab release, snapshot persistence) happens at the check
   * site, i.e. after the current page completes.
   */
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
   * Keepalive-port disconnect hook (multipage-download-fixes D2 / task 4.1
   * — REVERSES the old auto-stop behavior).
   *
   * A keepalive-port disconnect only means the side panel is gone. While the
   * service worker lives, the paused state stays controllable by a reopened
   * panel (a fresh panel reconnects a new port and its commands still reach
   * the scraper), so a disconnect while paused must NOT stop the scraper or
   * finalize the download. If the worker itself dies while the pause is
   * held, the download parks instead (checkpoint phase `paused` + queue
   * snapshot) — the parked path offers Resume/Stop.
   *
   * Kept as a logged no-op so the download-state disconnect plumbing (and
   * its tests) stay wired; the method is intentionally side-effect free.
   */
  handleKeepaliveDisconnect() {
    if (this.isPaused && !this.isStopped) {
      console.log(
        "[LinkedPageScraper] Keepalive port disconnected while paused — pause persists (parks on worker death), no auto-stop",
      );
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
    const isExternal = this.isExternalLink(job.url, job.parentUrl);

    // Check for external links if option is disabled
    if (isExternal && !this.options.includeExternal) {
      return;
    }

    // Check if we've reached the max page limit
    const combinedLength =
      this.internalQueue.length + this.externalQueue.length;
    if (combinedLength >= this.options.maxPages) {
      return;
    }

    // Check if URL is a non-HTML resource based on extension
    if (this.isNonHtmlResource(job.url)) {
      return;
    }

    // Check if URL is already in either queue
    if (
      this.internalQueue.some((j) => j.url === job.url) ||
      this.externalQueue.some((j) => j.url === job.url) ||
      this.scrapeUrls.has(job.url)
    ) {
      return;
    }

    // Track every accepted scrape target — restoreOriginalPage uses this set
    // to decide whether the tab is still on scraper-controlled navigation.
    this.scrapeUrls.add(job.url);

    if (isExternal) {
      this.externalQueue.push(job);
    } else {
      this.internalQueue.push(job);
    }
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
        ".pdf",
        ".zip",
        ".rar",
        ".7z",
        ".tar",
        ".gz",
        ".exe",
        ".dmg",
        ".iso",
        ".bin",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".svg",
        ".ico",
        ".mp3",
        ".mp4",
        ".avi",
        ".mov",
        ".mkv",
        ".webm",
        ".css",
        ".js",
        ".json",
        ".xml",
        ".txt",
        ".csv",
        ".stl",
        ".obj",
        ".3mf",
        ".fbx",
        ".dae",
        ".step",
        ".stp",
        ".iges",
        ".igs",
        ".dxf",
        ".dwg",
        ".gcode",
      ];

      return excludedExtensions.some((ext) => pathname.endsWith(ext));
    } catch (e) {
      return false;
    }
  }

  /**
   * Process all queued pages sequentially.
   *
   * (multipage-download-fixes D4 / task 3.2) Each page's body text is
   * uploaded IMMEDIATELY after its scrape via
   * `serverClient.uploadPageContent` (gated on extractText) — nothing is
   * accumulated and nothing is returned: the method resolves with no value.
   *
   * `context` (task 4.1) carries the per-download image filename map that
   * replaces the former module-global map — concurrent downloads in other
   * tabs can no longer corrupt each other's entries.
   */
  async processQueue(
    tabId: number,
    storage: IStorageAdapter,
    sendMessage: (message: string | { key: string; options?: any }) => void,
    context?: DownloadContext,
  ): Promise<void> {
    const totalInternal = this.internalQueue.length;
    const totalExternal = this.externalQueue.length;
    if (totalInternal === 0 && totalExternal === 0) {
      return;
    }

    // Per-download shared map (main page + linked pages of THIS download)
    const sharedImageFilenameMap =
      context?.imageFilenameMap ?? new Map<string, string>();

    try {
      const tab = await chrome.tabs.get(tabId);
      this.originalTabUrl = tab.url || "";
    } catch {
      // Ignore
    }

    // Phase 1: Process internal pages first
    for (let i = 0; i < this.internalQueue.length; i++) {
      // Check stop flag
      if (this.isStopped) {
        pushToPanelSafely(sendMessage, "Scraping stopped by user");
        break;
      }

      // Check pause flag — (multipage-download-fixes D2 / tasks 4.1–4.4)
      // TRUE pause: freeze the queue snapshot, release the tab, then wait
      // INDEFINITELY for resume or stop. No watchdog exists any more.
      if (this.isPaused) {
        pushToPanelSafely(sendMessage, { key: "status.scraperPaused" });
        await this.enterPausedWait(tabId, "internal");
        if (this.isStopped) break; // Check again after resume
        // (D2 / task 4.2) Re-acquire a tab before continuing — the original
        // may be gone after a long pause; never assume the old id is alive.
        tabId = await this.reacquireTab(tabId);
      }

      const job = this.internalQueue[i];

      pushToPanelSafely(sendMessage, {
        key: "status.linkedPageProgress",
        options: {
          current: i + 1,
          total: totalInternal,
          isPaused: this.isPaused,
          phase: "internal",
        },
      });

      try {
        job.status = "processing";

        const scrapedData = await this.scrapeLinkedPage(
          tabId,
          job.url,
          storage,
          sendMessage,
          context,
        );

        // Upload HTML chunks with pageType "linked" and pageUrl metadata.
        // All chunks for a page are uploaded concurrently to reduce latency
        // while preserving per-chunk scroll indices for correct server-side reassembly.
        const sessionId = this.options.serverSessionId!;
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

        // Upload incremental filename map after this linked page's
        // assets are downloaded. The delta map contains only the new entries
        // discovered for this linked page (images AND css/js/documents — fix G).
        const deltaMap: Record<string, string> = {};
        for (const [key, value] of scrapedData.localFilenameMap ?? []) {
          if (!sharedImageFilenameMap.has(key)) {
            deltaMap[key] = value;
          }
        }
        if (Object.keys(deltaMap).length > 0) {
          await serverClient.uploadFilenameMap(sessionId, deltaMap);
        }

        job.status = "completed";
        this.successCount++;

        // (multipage-download-fixes D4 / task 3.2) Stream this page's text
        // NOW — immediately after its scrape — instead of accumulating it
        // for an end-of-run append. A failure here is surfaced in the
        // failure counts but never fails the page (its HTML chunks and
        // delta map are already stored) and never stops the loop.
        if (this.extractText && scrapedData.text) {
          try {
            await serverClient.uploadPageContent(
              sessionId,
              scrapedData.finalUrl,
              scrapedData.text,
            );
          } catch (textError) {
            this.failCount++;
            console.warn(
              `[LinkedPageScraper] Text upload failed for ${job.url}:`,
              textError instanceof Error ? textError.message : textError,
            );
            pushToPanelSafely(
              sendMessage,
              `Failed to upload page text: ${job.url}`,
            );
          }
        }
      } catch (error) {
        // If this is a 413 session-full error, stop the scraper loop
        // immediately — further pages would also exceed the limit.
        const isSessionFull =
          error instanceof HttpError && error.statusCode === 413;
        if (isSessionFull) {
          job.status = "failed";
          this.failCount++;
          this.isStopped = true;
          // (multipage-download-fixes 5.8) The completion state must
          // communicate partial capture — pages captured vs queue total —
          // instead of an unqualified "Done".
          pushToPanelSafely(sendMessage, {
            key: "status.sessionFullPagesCaptured",
            options: {
              captured: this.successCount,
              total: totalInternal + totalExternal,
            },
          });
          break;
        }
        job.status = "failed";
        this.failCount++;
        pushToPanelSafely(sendMessage, `Failed to scrape: ${job.url}`);
      }

      // Add delay between pages to avoid rate limiting
      if (
        i < this.internalQueue.length - 1 &&
        this.options.delayBetweenPages > 0
      ) {
        await this.delay(this.options.delayBetweenPages);
      }
    }

    // Phase 2: Process external pages (only if not stopped)
    if (!this.isStopped) {
      for (let i = 0; i < this.externalQueue.length; i++) {
        // Check stop flag
        if (this.isStopped) {
          pushToPanelSafely(sendMessage, "Scraping stopped by user");
          break;
        }

        // Check pause flag — (multipage-download-fixes D2 / tasks 4.1–4.4)
        // Same true-pause hold as the internal phase (shared mechanism).
        if (this.isPaused) {
          pushToPanelSafely(sendMessage, { key: "status.scraperPaused" });
          await this.enterPausedWait(tabId, "external");
          if (this.isStopped) break;
          tabId = await this.reacquireTab(tabId);
        }

        const job = this.externalQueue[i];

        pushToPanelSafely(sendMessage, {
          key: "status.linkedPageProgress",
          options: {
            current: i + 1,
            total: totalExternal,
            isPaused: this.isPaused,
            phase: "external",
          },
        });

        try {
          job.status = "processing";

          const scrapedData = await this.scrapeLinkedPage(
            tabId,
            job.url,
            storage,
            sendMessage,
            context,
          );

          const sessionId = this.options.serverSessionId!;
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

          // Delta map: only entries this linked page newly discovered
          // (images AND css/js/documents — fix G).
          const deltaMap: Record<string, string> = {};
          for (const [key, value] of scrapedData.localFilenameMap ?? []) {
            if (!sharedImageFilenameMap.has(key)) {
              deltaMap[key] = value;
            }
          }
          if (Object.keys(deltaMap).length > 0) {
            await serverClient.uploadFilenameMap(sessionId, deltaMap);
          }

          job.status = "completed";
          this.successCount++;

          // (multipage-download-fixes D4 / task 3.2) External phase — same
          // per-page text streaming as the internal phase above.
          if (this.extractText && scrapedData.text) {
            try {
              await serverClient.uploadPageContent(
                sessionId,
                scrapedData.finalUrl,
                scrapedData.text,
              );
            } catch (textError) {
              this.failCount++;
              console.warn(
                `[LinkedPageScraper] Text upload failed for ${job.url}:`,
                textError instanceof Error ? textError.message : textError,
              );
              pushToPanelSafely(
                sendMessage,
                `Failed to upload page text: ${job.url}`,
              );
            }
          }
        } catch (error) {
          const isSessionFull =
            error instanceof HttpError && error.statusCode === 413;
          if (isSessionFull) {
            job.status = "failed";
            this.failCount++;
            this.isStopped = true;
            // (multipage-download-fixes 5.8) Same partial-capture note as
            // the internal phase's 413 exit.
            pushToPanelSafely(sendMessage, {
              key: "status.sessionFullPagesCaptured",
              options: {
                captured: this.successCount,
                total: totalInternal + totalExternal,
              },
            });
            break;
          }
          job.status = "failed";
          this.failCount++;
          pushToPanelSafely(sendMessage, `Failed to scrape: ${job.url}`);
        }

        if (
          i < this.externalQueue.length - 1 &&
          this.options.delayBetweenPages > 0
        ) {
          await this.delay(this.options.delayBetweenPages);
        }
      }
    }

    // Restore original page
    await this.restoreOriginalPage(tabId);

    // (D2 / task 4.3) Completion also clears the snapshot — a finished
    // download must never leave a parkable snapshot behind. (No-op unless a
    // pause wrote one; the session-scoped clear cannot touch other
    // downloads' snapshots.)
    if (this.options.serverSessionId) {
      try {
        await clearScraperSnapshot(this.options.serverSessionId);
      } catch {
        // Non-critical
      }
      this.prePauseCheckpointPhase = null;
    }

    // Send completion message
    pushToPanelSafely(sendMessage, {
      key: "status.linkedPagesComplete",
      options: { succeeded: this.successCount, failed: this.failCount },
    });
  }

  /**
   * (multipage-download-fixes D2 / tasks 4.1–4.4) The pause hold itself —
   * runs once per pause, after the current page completes:
   *
   * 1. Freeze the queue snapshot to `chrome.storage.session` (task 4.3) and
   *    flip the checkpoint phase to `paused` (task 4.4). The snapshot is
   *    frozen at THIS moment — pages completed while the pause is held don't
   *    exist because scraping is paused.
   * 2. Release the tab: restore the original page so no scraped page is
   *    held hostage for the duration of the pause (task 4.2).
   * 3. Await the resume promise — blocks indefinitely (no watchdog; task
   *    4.1). stop() resolves the same promise so the loop can exit.
   * 4. On lift (resume OR stop): clear the snapshot and restore the prior
   *    checkpoint phase (task 4.4).
   */
  private async enterPausedWait(
    tabId: number,
    phase: "internal" | "external",
  ): Promise<void> {
    await this.persistPauseSnapshot(tabId, phase);
    // (D2 / task 4.2) Tab release on pause — restoreOriginalPage only
    // navigates when the tab is still on scraper-controlled URLs, so a
    // user-navigated tab is left untouched.
    await this.restoreOriginalPage(tabId);
    await this.resumePromise;
    await this.onPauseLifted();
  }

  /**
   * (D2 / tasks 4.3 + 4.4) Persist the frozen pause snapshot and flip the
   * checkpoint to the `paused` phase. Server-session scrapers only —
   * snapshot failures are logged, never fatal to the pause.
   */
  private async persistPauseSnapshot(
    tabId: number,
    phase: "internal" | "external",
  ): Promise<void> {
    const sessionId = this.options.serverSessionId;
    if (!sessionId) {
      // Without a server session there is nothing to park/resume against.
      return;
    }
    try {
      const checkpoint = await readCheckpoint(sessionId);
      this.prePauseCheckpointPhase = checkpoint?.phase ?? "scraping";

      const toSnapshotJob = (j: LinkedPageJob): ScraperSnapshotJob => ({
        url: j.url,
        depth: j.depth,
        parentUrl: j.parentUrl,
      });
      const remainingInternal = this.internalQueue
        .filter((j) => j.status === "queued")
        .map(toSnapshotJob);
      const remainingExternal = this.externalQueue
        .filter((j) => j.status === "queued")
        .map(toSnapshotJob);
      // Visited/processed = every job no longer queued (completed, failed,
      // or mid-processing at write time). Resume-from-park skips these.
      const visitedUrls = [...this.internalQueue, ...this.externalQueue]
        .filter((j) => j.status !== "queued")
        .map((j) => j.url);

      const { internalQueue, externalQueue, truncated } =
        truncateSnapshotQueues(remainingInternal, remainingExternal);

      const snapshot: LinkedScraperSnapshot = {
        version: SCRAPER_SNAPSHOT_VERSION,
        serverSessionId: sessionId,
        tabId,
        tabUrl: this.originalTabUrl || undefined,
        phase,
        internalQueue,
        externalQueue,
        visitedUrls,
        successCount: this.successCount,
        failCount: this.failCount,
        options: {
          maxPages: this.options.maxPages,
          delayBetweenPages: this.options.delayBetweenPages,
          includeExternal: this.options.includeExternal,
          pageTimeout: this.options.pageTimeout,
          downloadImages: this.options.downloadImages,
          downloadAssets: this.options.downloadAssets,
          downloadDocuments: this.options.downloadDocuments,
          extractText: this.extractText,
        },
        previousCheckpointPhase: this.prePauseCheckpointPhase,
        ...(truncated ? { truncated: true } : {}),
        timestamp: Date.now(),
      };
      await writeScraperSnapshot(snapshot);
      // (D2 / task 4.4) Checkpoint phase `paused` while the pause is held —
      // worker-wake detection routes paused checkpoints to the parked path.
      await pauseCheckpoint(sessionId);
      if (truncated) {
        console.log(
          "[LinkedPageScraper] Pause snapshot truncated (>5,000 queued URLs) — Stop from this park finalizes the partial",
        );
      }
    } catch (err) {
      // A snapshot failure must never break the pause itself.
      console.warn(
        "[LinkedPageScraper] Failed to persist pause snapshot:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * (D2 / tasks 4.3 + 4.4) The pause was lifted (resume OR stop — the park
   * is consumed either way): clear the frozen snapshot and restore the
   * pre-pause checkpoint phase so upstream uploading/assembling transitions
   * keep working.
   */
  private async onPauseLifted(): Promise<void> {
    const sessionId = this.options.serverSessionId;
    if (!sessionId) return;
    try {
      await clearScraperSnapshot(sessionId);
      await restoreCheckpointPhase(sessionId);
    } catch (err) {
      console.warn(
        "[LinkedPageScraper] Failed to clear pause state:",
        err instanceof Error ? err.message : err,
      );
    }
    this.prePauseCheckpointPhase = null;
  }

  /**
   * (D2 / task 4.2) Re-acquire a scraping tab after a pause: reuse the
   * original tab when it still exists, otherwise create a background tab.
   * The scraper never assumes the old tabId is alive — callers reassign
   * their navigation target from the returned id. Public so
   * resumeFromParkedScrape can re-acquire on behalf of a respawned scraper
   * (the tab may have been closed while the download was parked).
   */
  async reacquireTab(previousTabId: number): Promise<number> {
    try {
      const tab = await chrome.tabs.get(previousTabId);
      if (tab && typeof tab.id === "number") {
        return tab.id;
      }
    } catch {
      // Original tab gone (closed while paused) — recreate below.
    }
    try {
      const created = await chrome.tabs.create({
        url: this.originalTabUrl || undefined,
        active: false,
      });
      if (typeof created.id === "number") {
        console.log(
          `[LinkedPageScraper] Original tab gone after pause — recreated background tab ${created.id}`,
        );
        return created.id;
      }
    } catch (err) {
      console.warn(
        "[LinkedPageScraper] Failed to recreate a background tab after pause:",
        err instanceof Error ? err.message : err,
      );
    }
    return previousTabId;
  }

  /**
   * Scrape a single linked page
   */
  private async scrapeLinkedPage(
    tabId: number,
    url: string,
    storage: IStorageAdapter,
    sendMessage: (message: string | { key: string; options?: any }) => void,
    context?: DownloadContext,
  ): Promise<ScrapedPageData> {
    // Navigate to the page and wait for it to load
    const finalUrl = await this.navigateAndWait(tabId, url);

    // Execute scroll script for lazy-loaded content
    await this.scrollPageForLazyLoading(tabId);

    // Capture the DOM in chunks to avoid holding the entire page outerHTML
    // as a single large string in extension memory.
    const htmlChunks = await this.capturePageDOMChunks(tabId);
    const html = htmlChunks.join("");

    // Extract resources
    const resources = getResources(html);
    const pageText = resources.text;

    // Download assets (checking registry first to avoid duplicates).
    // Returns the filename map for this page's newly downloaded assets
    // (images, stylesheets, scripts, documents — fix G).
    // The linked page's own URL is its document URL (D2 / task 1.5).
    const localFilenameMap = await this.downloadAssets(
      resources,
      storage,
      finalUrl,
      sendMessage,
      context,
    );

    // Return raw HTML chunks (unconverted) — the server handles URL conversion.
    return {
      html,
      htmlChunks,
      url,
      finalUrl,
      localFilenameMap,
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
  private async navigateAndWait(tabId: number, url: string): Promise<string> {
    // Remember the last URL we navigated to — restoreOriginalPage compares
    // the tab's current URL against it to detect user navigation (task 4.7).
    this.lastNavigatedUrl = url;
    // (D4 / task 4.1) Only resolve on a completion that belongs to THIS
    // navigation. A `complete` for a different URL (the previous page's
    // late completion) is ignored — otherwise the wrong page's DOM would be
    // captured for the job.
    const targetUrl = normalizeNavigationUrl(url);
    // Set when the tab begins loading the requested URL. A completion whose
    // URL differs from the target is accepted ONLY after the target was seen
    // loading (client-side redirect landed elsewhere) — never on a stale
    // completion belonging to a page this call did not navigate to.
    let sawTargetLoading = false;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Navigation timeout after ${this.options.pageTimeout}ms`),
        );
      }, this.options.pageTimeout);

      const listener = (
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo,
        tab: chrome.tabs.Tab,
      ) => {
        if (updatedTabId !== tabId) return;
        const eventUrl = changeInfo.url ?? tab.url ?? "";
        if (changeInfo.status === "loading") {
          if (normalizeNavigationUrl(eventUrl) === targetUrl) {
            sawTargetLoading = true;
          }
          return;
        }
        if (changeInfo.status !== "complete") return;
        const isTarget = normalizeNavigationUrl(eventUrl) === targetUrl;
        if (!isTarget && !sawTargetLoading) {
          // Stale completion from the previous page — keep waiting.
          return;
        }
        cleanup();
        resolve(eventUrl || url);
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

    // (D5 / task 5.1) Keep the timeout handle and clear it when the race
    // settles (winner OR timeout) so no stray timer outlives the capture.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("DOM capture timeout")),
        timeout,
      );
    });

    try {
      const result = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.documentElement.outerHTML,
        }),
        timeoutPromise,
      ]);

      if (!result || result.length === 0 || !result[0].result) {
        throw new Error("Failed to capture DOM");
      }

      return result[0].result as string;
    } finally {
      clearTimeout(timeoutId);
    }
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
   * JS heap, which can spike memory for large linked pages.
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

    // (D5 / task 5.1) Keep the timeout handle and clear it when the race
    // settles (winner OR timeout) so no stray timer outlives the capture.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("DOM chunk capture timeout")),
        timeout,
      );
    });

    let result;
    try {
      result = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const skeleton = document.documentElement.outerHTML.replace(
              /<body[^>]*>[\s\S]*<\/body>/i,
              "<body></body>",
            );
            const children: string[] = [];
            for (const child of Array.from(document.body.children)) {
              children.push((child as Element).outerHTML);
            }
            return { skeleton, bodyChildren: children } as {
              skeleton: string;
              bodyChildren: string[];
            };
          },
        }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

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
    const bodyOpen = bodyOpenMatch ? bodyOpenMatch[0] : "<body>";
    const skeletonBeforeBody = skeleton.slice(0, skeleton.indexOf(bodyOpen));
    const skeletonAfterBody =
      "</body>" +
      skeleton.slice(skeleton.indexOf("</body>") + "</body>".length);

    for (const child of bodyChildren) {
      currentChildren.push(child);
      currentSize += child.length;

      if (currentSize >= targetChunkBytes) {
        chunks.push(
          skeletonBeforeBody +
            bodyOpen +
            currentChildren.join("") +
            skeletonAfterBody,
        );
        currentChildren = [];
        currentSize = 0;
      }
    }

    // Flush the last batch
    if (currentChildren.length > 0) {
      chunks.push(
        skeletonBeforeBody +
          bodyOpen +
          currentChildren.join("") +
          skeletonAfterBody,
      );
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
          const remaining = () =>
            Math.max(0, budgetMs - (Date.now() - startTime));

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
              const isAtBottom =
                currentScrollY + viewportHeight >= currentScrollHeight - buffer;
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
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(300, remaining())),
              );
              iterations++;
            }
          }

          // --- Single adaptive pass with settle delay ---
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
   * Returns the filename map for this page's newly downloaded assets
   * (images, stylesheets, scripts, documents — fix G).
   *
   * Dedup resolution (task 1.6): relative hrefs are resolved against
   * `pageUrl` — the same document URL passed to the handlers — so the
   * dedup filter and the fetchers agree on the absolute URL keys.
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
    context?: DownloadContext,
  ): Promise<Map<string, string>> {
    const localFilenameMap = new Map<string, string>();
    const handlerOptions: HandlerOptions = { documentUrl: pageUrl };

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

    // Download new assets — each handler returns its filename map
    // (raw reference AND absolute URL → archive path; fix G).
    // Per-category gates (multipage-download-fixes D1): mirror the main
    // page's gates in download-core — images on downloadImages, css/js on
    // downloadAssets, documents on downloadDocuments — so a text/markdown-
    // only run fetches no assets at all while images-only and documents-
    // only modes stay intact. The gates use the press-time snapshot passed
    // via the constructor options (never re-read live mid-run).
    const cssMap =
      this.options.downloadAssets && newCss.length > 0
        ? await addCssFiles(
            newCss,
            storage,
            pageUrl,
            sendMessage,
            context?.downloadId,
            handlerOptions,
          )
        : undefined;

    const jsMap =
      this.options.downloadAssets && newJs.length > 0
        ? await addJsFiles(
            newJs,
            storage,
            pageUrl,
            sendMessage,
            context?.downloadId,
            handlerOptions,
          )
        : undefined;

    const downloadedMap =
      this.options.downloadImages && newImages.length > 0
        ? await addImageFiles(
            newImages,
            storage,
            pageUrl,
            sendMessage,
            context?.downloadId,
            handlerOptions,
          )
        : undefined;

    const docsMap =
      this.options.downloadDocuments && newDocuments.length > 0
        ? await addDocumentFiles(
            newDocuments,
            storage,
            pageUrl,
            sendMessage,
            context?.downloadId,
            handlerOptions,
          )
        : undefined;

    // Merge into this page's local map and the per-download shared map.
    // Image entries first and never overwritten, then css/js/documents —
    // mirroring the main-page merge in download-core (fix G).
    const sharedMap = context?.imageFilenameMap;
    for (const [key, value] of downloadedMap ?? []) {
      localFilenameMap.set(key, value);
      sharedMap?.set(key, value);
    }
    for (const [key, value] of mergeFilenameMaps(cssMap, jsMap, docsMap)) {
      if (!localFilenameMap.has(key)) localFilenameMap.set(key, value);
      if (sharedMap && !sharedMap.has(key)) sharedMap.set(key, value);
    }

    // Register all assets (including ones we skipped).
    // Paths use the same buildArchivePath the upload handlers use (D5).
    for (const url of resources.css) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(
          fullUrl,
          buildArchivePath(fullUrl, "styles"),
          0,
        );
      }
    }

    for (const url of resources.js) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(
          fullUrl,
          buildArchivePath(fullUrl, "scripts"),
          0,
        );
      }
    }

    for (const url of resources.images) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(
          fullUrl,
          buildArchivePath(fullUrl, "images"),
          0,
        );
      }
    }

    for (const url of resources.documents) {
      const fullUrl = new URL(url, pageUrl).href;
      if (!this.assetRegistry.has(fullUrl)) {
        this.assetRegistry.register(
          fullUrl,
          buildArchivePath(fullUrl, "documents"),
          0,
        );
      }
    }

    return localFilenameMap;
  }

  /**
   * Restore the original page after scraping.
   *
   * Guard (task 4.7): only navigate back when the tab is still on
   * scraper-controlled navigation — i.e. its current URL is one of the
   * scrape targets (or the last URL this scraper navigated to). If the user
   * navigated elsewhere mid-scrape, their page is left untouched.
   */
  private async restoreOriginalPage(tabId: number): Promise<void> {
    if (!this.originalTabUrl) {
      return;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url || "";

      // Already back on the original page — nothing to do
      if (currentUrl === this.originalTabUrl) {
        return;
      }

      // User navigated away from the scrape set — do not clobber their page
      const onScrapeTarget =
        this.scrapeUrls.has(currentUrl) ||
        (this.lastNavigatedUrl !== "" && currentUrl === this.lastNavigatedUrl);
      if (!onScrapeTarget) {
        console.log(
          "[LinkedPageScraper] Skipping restore — user navigated away from the scrape set:",
          currentUrl,
        );
        return;
      }

      await chrome.tabs.update(tabId, { url: this.originalTabUrl });
    } catch {
      // Non-critical error, continue anyway
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
    const combined = this.combinedQueue;
    return {
      total: combined.length,
      succeeded: this.successCount,
      failed: this.failCount,
      pending: combined.filter((j) => j.status === "queued").length,
    };
  }
}

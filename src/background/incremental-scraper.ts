import { ScrapingQueueManager } from './storage/scraping-queue';
import { FileStore } from './storage/file-store';
import { SessionManager } from './storage/session-manager';
import i18n from '../i18n/config';

export class IncrementalScraper {
  private sessionId: string;
  private maxDepth: number;
  private maxPages: number;
  private isPaused: boolean = false;

  constructor(sessionId: string, maxDepth: number = 3, maxPages: number = 200) {
    this.sessionId = sessionId;
    this.maxDepth = maxDepth;
    this.maxPages = maxPages;
  }

  /**
   * Start incremental scraping
   */
  async start(startUrl: string): Promise<void> {
    // Add initial URL to queue
    await ScrapingQueueManager.enqueue(this.sessionId, startUrl, 0);

    // Process queue
    await this.processQueue();
  }

  /**
   * Resume incremental scraping
   */
  async resume(): Promise<void> {
    this.isPaused = false;
    await this.processQueue();
  }

  /**
   * Pause incremental scraping
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * Process scraping queue
   */
  private async processQueue(): Promise<void> {
    while (!this.isPaused) {
      // Get next URL
      const item = await ScrapingQueueManager.dequeue(this.sessionId);
      if (!item) {
        break;
      }

      // Check if we've hit max pages
      const stats = await ScrapingQueueManager.getStats(this.sessionId);
      if (stats.completed >= this.maxPages) {
        break;
      }

      try {
        
        // Scrape page
        const { html, links } = await this.scrapePage(item.url);
        
        // Store HTML in IndexedDB
        const path = this.getPathForUrl(item.url);
        await FileStore.storeFile(this.sessionId, path, html, 'text/html');
        
        // Add discovered links to queue (if within depth limit)
        if (item.depth < this.maxDepth) {
          for (const link of links) {
            await ScrapingQueueManager.enqueue(
              this.sessionId,
              link,
              item.depth + 1,
              item.url
            );
          }
        }
        
        // Mark as completed
        await ScrapingQueueManager.markCompleted(item.id);
        
        // Update session progress
        const updatedStats = await ScrapingQueueManager.getStats(this.sessionId);
        await SessionManager.saveScrapingProgress(this.sessionId, {
          totalPages: updatedStats.total,
          scrapedPages: updatedStats.completed,
          currentPage: item.url,
          pendingUrls: [] // Not needed with queue
        });
        
        // Small delay to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`Failed to scrape ${item.url}:`, error);
        await ScrapingQueueManager.markFailed(item.id, error instanceof Error ? error.message : i18n.t('app.unknownError'));
      }
    }

    if (this.isPaused) {
      await SessionManager.pauseSession(this.sessionId);
    } else {
      await SessionManager.updateSession(this.sessionId, {
        status: 'partitioning'
      });
    }
  }

  /**
   * Scrape a single page
   */
  private async scrapePage(url: string): Promise<{
    html: string;
    links: string[];
  }> {
    // Fetch page
    const response = await fetch(url);
    const html = await response.text();
    
    // Extract links
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const anchors = doc.querySelectorAll('a[href]');
    const links = Array.from(anchors)
      .map(a => a.getAttribute('href'))
      .filter(href => href && href.startsWith('http'))
      .map(href => new URL(href!, url).href);
    
    return { html, links };
  }

  /**
   * Generate file path from URL
   */
  private getPathForUrl(url: string): string {
    const urlObj = new URL(url);
    const path = urlObj.pathname.replace(/^\//, '').replace(/\/$/, '') || 'index';
    return `${path}.html`;
  }
}

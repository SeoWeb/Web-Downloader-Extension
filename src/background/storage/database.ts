import Dexie, { Table } from 'dexie';

export interface ScrapedFile {
  id: string;              // Format: "downloadId-filepath"
  downloadId: string;      // Groups files by download session
  path: string;            // Relative path in ZIP: "images/logo.png"
  blob: Blob;              // Actual file content (stored on disk)
  size: number;            // File size in bytes
  mimeType: string;        // MIME type: "image/png", "text/html", etc.
  timestamp: number;       // When file was scraped (for cleanup)
  metadata?: {             // Optional metadata
    originalUrl?: string;
    encoding?: string;
    compressed?: boolean;
  };
}

export interface DownloadSession {
  id: string;              // Download session ID
  baseUrl: string;         // Original URL being scraped
  totalFiles: number;      // Total files scraped
  totalSize: number;       // Total size in bytes
  status: 'scraping' | 'paused' | 'partitioning' | 'downloading' | 'complete' | 'failed';
  startTime: number;
  endTime?: number;
  error?: string;
  
  // Pause/Resume state (Phase 9)
  pausedAt?: number;
  resumedAt?: number;
  scrapingProgress?: {
    totalPages: number;
    scrapedPages: number;
    currentPage?: string;
    pendingUrls: string[];  // URLs not yet scraped
  };
}

export interface ScrapingQueue {
  id: string;
  sessionId: string;
  url: string;
  depth: number;
  parentUrl?: string;
  status: 'pending' | 'scraping' | 'completed' | 'failed';
  addedAt: number;
  scrapedAt?: number;
  error?: string;
  retryCount: number;
}

class WebsiteDownloaderDB extends Dexie {
  files!: Table<ScrapedFile, string>;
  sessions!: Table<DownloadSession, string>;
  scrapingQueue!: Table<ScrapingQueue, string>;

  constructor() {
    super('WebsiteDownloaderDB');
    
    // Version 1: Initial schema
    this.version(1).stores({
      files: 'id, downloadId, timestamp, size',
      sessions: 'id, status, startTime'
    });

    // Version 2: Add scraping queue for incremental scraping
    this.version(2).stores({
      files: 'id, downloadId, timestamp, size',
      sessions: 'id, status, startTime',
      scrapingQueue: 'id, sessionId, status, depth, addedAt'
    });
  }
}

export const db = new WebsiteDownloaderDB();

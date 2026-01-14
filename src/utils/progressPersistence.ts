/**
 * Progress Persistence System
 * Handles storage and retrieval of streaming download progress using IndexedDB
 */

import {
  StreamingDownload,
  ProgressPersistence,
  ChunkInfo,
  StreamingDownloadStatus,
} from '../types/streaming';

const DB_NAME = 'StreamingDownloadsDB';
const DB_VERSION = 1;
const STORE_NAME = 'downloads';

interface StoredChunkInfo extends ChunkInfo {
  /** Serialized data if needed */
  serializedData?: string;
}

interface StoredStreamingDownload extends Omit<StreamingDownload, 'chunks'> {
  /** Serialized chunks */
  chunks: StoredChunkInfo[];
}

class IndexedDBProgressPersistence implements ProgressPersistence {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.initPromise = this.initializeDB();
  }

  /**
   * Initialize IndexedDB database
   */
  private async initializeDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open database: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });

          // Create indexes for efficient querying
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('url', 'url', { unique: false });
        }
      };
    });
  }

  /**
   * Ensure database is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDB();
    }
    await this.initPromise;
  }

  /**
   * Save download progress to IndexedDB
   */
  async saveProgress(download: StreamingDownload): Promise<void> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      // Prepare chunks for storage - we don't store actual data to save space
      const storedChunks: StoredChunkInfo[] = download.chunks.map(chunk => ({
        ...chunk,
        data: undefined, // Don't store actual chunk data in IndexedDB
        serializedData: undefined,
      }));

      const storedDownload: StoredStreamingDownload = {
        ...download,
        chunks: storedChunks,
      };

      // Serialize complex objects if needed
      const serializedDownload = this.serializeForStorage(storedDownload);

      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const request = store.put(serializedDownload);

        request.onerror = () => {
          reject(new Error(`Failed to save progress: ${request.error?.message}`));
        };

        request.onsuccess = () => {
          resolve();
        };
      });

      // Clean up old downloads if needed
      await this.performCleanup();
    } catch (error) {
      throw error;
    }
  }

  /**
   * Load download progress from IndexedDB
   */
  async loadProgress(downloadId: string): Promise<StreamingDownload | null> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);

      const storedDownload = await new Promise<StoredStreamingDownload | null>((resolve, reject) => {
        const request = store.get(downloadId);

        request.onerror = () => {
          reject(new Error(`Failed to load progress: ${request.error?.message}`));
        };

        request.onsuccess = () => {
          const result = request.result;
          resolve(result ? this.deserializeFromStorage(result) : null);
        };
      });

      if (!storedDownload) {
        return null;
      }

      // Convert back to StreamingDownload format
      return {
        ...storedDownload,
        chunks: storedDownload.chunks.map(chunk => ({
          ...chunk,
          data: undefined, // Data will be re-downloaded
        })),
      };
    } catch {
      return null;
    }
  }

  /**
   * Remove download progress from IndexedDB
   */
  async removeProgress(downloadId: string): Promise<void> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const request = store.delete(downloadId);

        request.onerror = () => {
          reject(new Error(`Failed to remove progress: ${request.error?.message}`));
        };

        request.onsuccess = () => {
          resolve();
        };
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * List all persisted download IDs
   */
  async listPersistedDownloads(): Promise<string[]> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);

      const downloadIds = await new Promise<string[]>((resolve, reject) => {
        const request = store.getAllKeys();

        request.onerror = () => {
          reject(new Error(`Failed to list downloads: ${request.error?.message}`));
        };

        request.onsuccess = () => {
          resolve(request.result as string[]);
        };
      });

      return downloadIds;
    } catch {
      return [];
    }
  }

  /**
   * Clean up old downloads
   */
  async cleanup(olderThan: number = 7 * 24 * 60 * 60 * 1000): Promise<void> { // 7 days default
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const cutoffTime = Date.now() - olderThan;
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      // Get all downloads to check their age
      const downloads = await new Promise<StoredStreamingDownload[]>((resolve, reject) => {
        const request = store.getAll();

        request.onerror = () => {
          reject(new Error(`Failed to get downloads for cleanup: ${request.error?.message}`));
        };

        request.onsuccess = () => {
          resolve(request.result as StoredStreamingDownload[]);
        };
      });

      // Remove old completed or failed downloads
      for (const download of downloads) {
        const isOld = download.updatedAt < cutoffTime;
        const isCompletable = download.status === 'completed' || download.status === 'failed';

        if (isOld && isCompletable) {
          await new Promise<void>((resolve, reject) => {
            const deleteRequest = store.delete(download.id);

            deleteRequest.onerror = () => {
              reject(new Error(`Failed to delete old download: ${deleteRequest.error?.message}`));
            };

            deleteRequest.onsuccess = () => {
              resolve();
            };
          });
        }
      }
    } catch {
    }
  }

  /**
   * Get download statistics
   */
  async getStatistics(): Promise<{
    totalDownloads: number;
    activeDownloads: number;
    completedDownloads: number;
    failedDownloads: number;
    totalSize: number;
  }> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const downloads = await new Promise<StoredStreamingDownload[]>((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onerror = () => {
          reject(new Error(`Failed to get statistics: ${request.error?.message}`));
        };

        request.onsuccess = () => {
          resolve(request.result as StoredStreamingDownload[]);
        };
      });

      const stats = {
        totalDownloads: downloads.length,
        activeDownloads: downloads.filter(d => d.status === 'streaming' || d.status === 'paused').length,
        completedDownloads: downloads.filter(d => d.status === 'completed').length,
        failedDownloads: downloads.filter(d => d.status === 'failed').length,
        totalSize: downloads.reduce((sum, d) => sum + d.totalSize, 0),
      };

      return stats;
    } catch {
      return {
        totalDownloads: 0,
        activeDownloads: 0,
        completedDownloads: 0,
        failedDownloads: 0,
        totalSize: 0,
      };
    }
  }

  /**
   * Find downloads by URL pattern
   */
  async findDownloadsByUrl(urlPattern: string): Promise<StreamingDownload[]> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const downloads = await new Promise<StoredStreamingDownload[]>((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onerror = () => {
          reject(new Error(`Failed to find downloads: ${request.error?.message}`));
        };

        request.onsuccess = () => {
          resolve(request.result as StoredStreamingDownload[]);
        };
      });

      const regex = new RegExp(urlPattern, 'i');
      const matchingDownloads = downloads.filter(d => regex.test(d.url));

      return matchingDownloads.map(download => ({
        ...download,
        chunks: download.chunks.map(chunk => ({
          ...chunk,
          data: undefined,
        })),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Update download status
   */
  async updateDownloadStatus(
    downloadId: string,
    status: StreamingDownloadStatus,
    error?: string
  ): Promise<void> {
    await this.ensureInitialized();

    const download = await this.loadProgress(downloadId);
    if (!download) {
      throw new Error(`Download not found: ${downloadId}`);
    }

    download.status = status;
    download.updatedAt = Date.now();
    if (error) {
      download.error = error;
    }

    await this.saveProgress(download);
  }

  /**
   * Perform periodic cleanup
   */
  private async performCleanup(): Promise<void> {
    try {
      // Clean up downloads older than 24 hours
      await this.cleanup(24 * 60 * 60 * 1000);
    } catch {
      // Ignore
    }
  }

  /**
   * Serialize download for storage (handle non-serializable parts)
   */
  private serializeForStorage(download: StoredStreamingDownload): any {
    // Create a plain object copy
    const serialized = { ...download } as any;

    // These are already timestamps in the interface, no conversion needed
    // Keeping this code for backward compatibility in case Date objects are passed
    if (serialized.startedAt instanceof Date) {
      serialized.startedAt = serialized.startedAt.getTime();
    }
    if (serialized.updatedAt instanceof Date) {
      serialized.updatedAt = serialized.updatedAt.getTime();
    }
    if (serialized.completedAt && serialized.completedAt instanceof Date) {
      serialized.completedAt = serialized.completedAt.getTime();
    }

    // Ensure chunks are properly serialized
    serialized.chunks = serialized.chunks.map((chunk: StoredChunkInfo) => ({
      ...chunk,
      downloadedAt: chunk.downloadedAt ? chunk.downloadedAt : undefined,
    }));

    return serialized;
  }

  /**
   * Deserialize download from storage
   */
  private deserializeFromStorage(stored: any): StoredStreamingDownload {
    // Keep as timestamps since the interface expects numbers
    // Only convert if they're stored as Date objects (for backward compatibility)
    if (stored.startedAt instanceof Date) {
      stored.startedAt = stored.startedAt.getTime();
    }
    if (stored.updatedAt instanceof Date) {
      stored.updatedAt = stored.updatedAt.getTime();
    }
    if (stored.completedAt instanceof Date) {
      stored.completedAt = stored.completedAt.getTime();
    }

    // Ensure chunks are properly deserialized
    if (Array.isArray(stored.chunks)) {
      stored.chunks = stored.chunks.map((chunk: any) => ({
        ...chunk,
        downloadedAt: chunk.downloadedAt ? chunk.downloadedAt : undefined,
      }));
    }

    return stored as StoredStreamingDownload;
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initPromise = null;
  }

  /**
   * Clear all stored data
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const transaction = this.db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.clear();

      request.onerror = () => {
        reject(new Error(`Failed to clear database: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }
}

/**
 * Memory-based progress persistence for testing or temporary storage
 */
class MemoryProgressPersistence implements ProgressPersistence {
  private storage = new Map<string, StreamingDownload>();

  async saveProgress(download: StreamingDownload): Promise<void> {
    // Create a copy without actual chunk data to save memory
    const sanitizedDownload = {
      ...download,
      chunks: download.chunks.map(chunk => ({
        ...chunk,
        data: undefined,
      })),
    };

    this.storage.set(download.id, sanitizedDownload);
  }

  async loadProgress(downloadId: string): Promise<StreamingDownload | null> {
    const download = this.storage.get(downloadId);
    return download ? { ...download } : null;
  }

  async removeProgress(downloadId: string): Promise<void> {
    this.storage.delete(downloadId);
  }

  async listPersistedDownloads(): Promise<string[]> {
    return Array.from(this.storage.keys());
  }

  async cleanup(olderThan: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    const cutoffTime = Date.now() - olderThan;

    for (const [downloadId, download] of this.storage.entries()) {
      const isOld = download.updatedAt < cutoffTime;
      const isCompletable = download.status === 'completed' || download.status === 'failed';

      if (isOld && isCompletable) {
        this.storage.delete(downloadId);
      }
    }
  }

  /**
   * Clear all memory storage
   */
  clear(): void {
    this.storage.clear();
  }

  /**
   * Get current storage size
   */
  getStorageSize(): number {
    return this.storage.size;
  }
}

/**
 * Factory function to create appropriate persistence implementation
 */
export function createProgressPersistence(
  type: 'indexeddb' | 'memory' = 'indexeddb'
): ProgressPersistence {
  switch (type) {
    case 'indexeddb':
      return new IndexedDBProgressPersistence();
    case 'memory':
      return new MemoryProgressPersistence();
    default:
      throw new Error(`Unknown persistence type: ${type}`);
  }
}
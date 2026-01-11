export interface DownloadProgress {
  sessionId: string;
  phase: 'scraping' | 'partitioning' | 'downloading';
  totalItems: number;
  completedItems: number;
  currentItem?: string;
  startTime: number;
  lastUpdateTime: number;
  estimatedTimeRemaining?: number;
}

export class ProgressTracker {
  private static STORAGE_KEY = 'download_progress';

  /**
   * Save progress to chrome.storage.local (persists across restarts)
   */
  static async saveProgress(progress: DownloadProgress): Promise<void> {
    await chrome.storage.local.set({
      [this.STORAGE_KEY]: progress
    });
  }

  /**
   * Load progress from storage
   */
  static async loadProgress(): Promise<DownloadProgress | null> {
    const result = await chrome.storage.local.get(this.STORAGE_KEY);
    return result[this.STORAGE_KEY] || null;
  }

  /**
   * Clear progress after completion
   */
  static async clearProgress(): Promise<void> {
    await chrome.storage.local.remove(this.STORAGE_KEY);
  }

  /**
   * Calculate estimated time remaining
   */
  static calculateETA(progress: DownloadProgress): number {
    const elapsed = Date.now() - progress.startTime;
    const rate = progress.completedItems / elapsed; // items per ms
    const remaining = progress.totalItems - progress.completedItems;
    return remaining / rate; // ms remaining
  }
}

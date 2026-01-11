/**
 * Asset Registry for tracking downloaded assets across main page and linked pages.
 * Prevents duplicate downloads by maintaining a registry of all downloaded assets.
 */

export interface AssetEntry {
  originalUrl: string;
  localPath: string; // e.g., "assets/images/logo.png"
  size: number;
  downloadedAt: number;
}

export class AssetRegistry {
  private assets: Map<string, AssetEntry> = new Map();

  /**
   * Register a downloaded asset
   */
  register(url: string, localPath: string, size: number): void {
    this.assets.set(url, {
      originalUrl: url,
      localPath,
      size,
      downloadedAt: Date.now(),
    });
  }

  /**
   * Check if an asset has already been downloaded
   */
  has(url: string): boolean {
    return this.assets.has(url);
  }

  /**
   * Get asset entry by URL
   */
  get(url: string): AssetEntry | undefined {
    return this.assets.get(url);
  }

  /**
   * Clear all registered assets
   */
  clear(): void {
    this.assets.clear();
  }

  /**
   * Get total number of registered assets
   */
  size(): number {
    return this.assets.size;
  }

  /**
   * Get all registered asset URLs
   */
  getUrls(): string[] {
    return Array.from(this.assets.keys());
  }

  /**
   * Get total size of all registered assets
   */
  getTotalSize(): number {
    let total = 0;
    for (const entry of this.assets.values()) {
      total += entry.size;
    }
    return total;
  }
}

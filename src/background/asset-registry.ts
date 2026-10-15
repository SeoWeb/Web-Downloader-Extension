/**
 * Asset Registry for tracking downloaded assets across main page and linked pages.
 * Prevents duplicate downloads by maintaining a registry of all downloaded assets.
 */

import * as urlUtils from "./urlUtils";
import { fixFilename } from "./urlUtils";

export interface AssetEntry {
  originalUrl: string;
  localPath: string; // e.g., "assets/images/logo.png"
  size: number;
  downloadedAt: number;
}

// ---------------------------------------------------------------------------
// buildArchivePath (D5 / tasks 3.1 + 4.1)
// ---------------------------------------------------------------------------

/**
 * Local fallback implementation matching the documented signature
 * `buildArchivePath(url: string, category: string): string`.
 *
 * Preserves sanitized pathname segments under `<category>/` and appends the
 * query-hash filename (via fixFilename) so two same-basename files from
 * different directories get distinct archive paths.
 *
 * NOTE: `src/background/urlUtils.ts` owns the canonical implementation
 * (added concurrently). When present it is preferred wholesale so registry
 * keys are guaranteed to equal the paths the file handlers upload to; this
 * fallback only exists so the registry works before that lands.
 */
function fallbackBuildArchivePath(url: string, category: string): string {
  const safeCategory = (category || "assets").replace(/[^a-z0-9_-]/gi, "");
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname
      .split("/")
      .filter((s) => s.length > 0);

    if (segments.length === 0) {
      return `${safeCategory}/${fixFilename(url)}`;
    }

    // Directory segments: sanitized but structure-preserving
    const dirSegments = segments
      .slice(0, -1)
      .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, "-"))
      .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");

    // File segment: fixFilename applies the query-hash disambiguation
    const filename = fixFilename(segments[segments.length - 1]);

    return [safeCategory, ...dirSegments, filename].join("/");
  } catch {
    // Relative or unparseable input — fall back to a flat sanitized name
    return `${safeCategory}/${fixFilename(url)}`;
  }
}

function resolveBuildArchivePath(): (url: string, category: string) => string {
  const canonical = (urlUtils as { buildArchivePath?: unknown }).buildArchivePath;
  if (typeof canonical === "function") {
    return canonical as (url: string, category: string) => string;
  }
  return fallbackBuildArchivePath;
}

/**
 * Build the archive path for a resource.
 *
 * Delegates to the canonical `buildArchivePath(url, category)` in
 * `src/background/urlUtils.ts` when available (see note above) so the asset
 * registry keys are always built by the same function the file handlers use
 * for upload paths.
 */
export function buildArchivePath(url: string, category: string): string {
  return resolveBuildArchivePath()(url, category);
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

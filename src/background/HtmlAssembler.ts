/**
 * HTML Assembler for incremental HTML content assembly
 * Replaces the expensive DOM merging approach with efficient chunk-based assembly
 */

import { adaptiveMemoryManager, MemoryPressureLevel } from '../utils/AdaptiveMemoryManager';

export interface AssemblyJob {
  id: string;
  skeleton: string; // The main page structure with a placeholder
  chunks: string[]; // Array of HTML strings to be inserted
  totalSize: number;
  createdAt: number;
  lastUpdated: number;
  insertionPoint: string; // Where to insert chunks (default: "</body>")
  /**
   * Dedup set storing composite "hash:scrollIndex" keys.
   * Using composite key (not hash-alone) so identical content at different scroll
   * positions is NOT dropped — only genuine retransmissions of the same (content, position)
   * are deduplicated. (Fix for issue C2.)
   */
  chunkHashes: Set<string>;
}

export interface AssemblyOptions {
  maxTotalSize?: number;
  maxChunkSize?: number;
  enableDeduplication?: boolean;
  enableMinification?: boolean;
  insertionPoint?: string;
}

export interface AssemblyStats {
  totalChunks: number;
  totalSize: number;
  duplicateChunks: number;
  compressionRatio: number;
  estimatedFinalSize: number;
}

export class HtmlAssembler {
  private jobs: Map<string, AssemblyJob> = new Map();
  private defaultOptions: Required<AssemblyOptions>;

  constructor() {
    this.defaultOptions = {
      maxTotalSize: adaptiveMemoryManager.calculateSafeHtmlLimit(),
      maxChunkSize: adaptiveMemoryManager.calculateSafeChunkSize(),
      enableDeduplication: true,
      enableMinification: false,
      insertionPoint: '</body>',
    };
  }

  /**
   * Initialize a new assembly job
   */
  initializeJob(id: string, skeletonHtml: string, options: AssemblyOptions = {}): AssemblyJob {
    const finalOptions = { ...this.defaultOptions, ...options };
    
    // Ensure skeleton has insertion point
    const processedSkeleton = this.ensureInsertionPoint(skeletonHtml, finalOptions.insertionPoint);
    
    const job: AssemblyJob = {
      id,
      skeleton: processedSkeleton,
      chunks: [],
      totalSize: processedSkeleton.length,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      insertionPoint: finalOptions.insertionPoint,
      chunkHashes: new Set(),
    };

    this.jobs.set(id, job);
    return job;
  }

  /**
   * Add a chunk to an existing assembly job.
   * @param scrollIndex - The scroll position index for this chunk. Required for correct
   *   deduplication: two chunks with identical content but different scrollIndex values
   *   are treated as distinct (not duplicates). Two chunks with the same content AND
   *   same scrollIndex are treated as retransmissions and the second is dropped.
   */
  addChunk(jobId: string, chunkHtml: string, options: AssemblyOptions & { scrollIndex?: number } = {}): {
    success: boolean;
    added: boolean;
    reason?: string;
    newSize?: number;
  } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        success: false,
        added: false,
        reason: `Job ${jobId} not found`,
      };
    }

    const { scrollIndex = 0 } = options;
    const finalOptions = { ...this.defaultOptions, ...options };
    
    // Check memory pressure
    const memoryPressure = adaptiveMemoryManager.getMemoryPressureLevel();
    if (memoryPressure === MemoryPressureLevel.CRITICAL) {
      return {
        success: false,
        added: false,
        reason: 'Critical memory pressure, cannot add more chunks',
      };
    }

    // Process chunk
    let processedChunk = chunkHtml;
    
    // Minify if enabled
    if (finalOptions.enableMinification) {
      processedChunk = this.minifyHtml(processedChunk);
    }

    // Strict chunk size checks
    const chunkSize = processedChunk.length;
    
    // Check if individual chunk is too large (should not exceed 25% of max HTML size)
    const maxAbsoluteChunkSize = finalOptions.maxTotalSize / 4;
    if (chunkSize > maxAbsoluteChunkSize) {
      return {
        success: false,
        added: false,
        reason: `Chunk too large: ${adaptiveMemoryManager.formatBytes(chunkSize)} exceeds maximum chunk size of ${adaptiveMemoryManager.formatBytes(maxAbsoluteChunkSize)}`,
      };
    }
    
    // Check against configured max chunk size
    if (chunkSize > finalOptions.maxChunkSize) {
      // Try to split large chunks, but reject if they're way too big
      if (chunkSize > finalOptions.maxChunkSize * 2) {
        return {
          success: false,
          added: false,
          reason: `Chunk too large to process: ${adaptiveMemoryManager.formatBytes(chunkSize)} (max: ${adaptiveMemoryManager.formatBytes(finalOptions.maxChunkSize)})`,
        };
      }
    }
    
    // Additional safety check: if we're at high memory pressure, be more conservative
    if (memoryPressure === MemoryPressureLevel.HIGH && chunkSize > finalOptions.maxChunkSize / 2) {
      return {
        success: false,
        added: false,
        reason: `High memory pressure detected, chunk too large: ${adaptiveMemoryManager.formatBytes(chunkSize)}`,
      };
    }

    // Deduplication check: composite (contentHash, scrollIndex) key.
    // Same content at a different scroll position is intentionally NOT a duplicate;
    // only an exact retransmission of the same (content, position) pair is skipped.
    if (finalOptions.enableDeduplication) {
      const chunkHash = this.generateHash(processedChunk);
      const dedupKey = `${chunkHash}:${scrollIndex}`;
      if (job.chunkHashes.has(dedupKey)) {
        return {
          success: true,
          added: false,
          reason: `Duplicate chunk detected (hash:scrollIndex = ${dedupKey})`,
        };
      }
      job.chunkHashes.add(dedupKey);
    }

    // Check total size limit with safety margin
    const newTotalSize = job.totalSize + processedChunk.length;
    const safetyMargin = memoryPressure === MemoryPressureLevel.HIGH ? 0.8 : 0.95; // More conservative under high pressure
    const effectiveMaxSize = finalOptions.maxTotalSize * safetyMargin;
    
    if (newTotalSize > effectiveMaxSize) {
      return {
        success: false,
        added: false,
        reason: `Total size would exceed limit: ${adaptiveMemoryManager.formatBytes(newTotalSize)} > ${adaptiveMemoryManager.formatBytes(effectiveMaxSize)} (safety margin applied)`,
      };
    }
    
    // Hard limit check (should never be exceeded due to safety margin)
    if (newTotalSize > finalOptions.maxTotalSize) {
      return {
        success: false,
        added: false,
        reason: `Total size would exceed hard limit: ${adaptiveMemoryManager.formatBytes(newTotalSize)} > ${adaptiveMemoryManager.formatBytes(finalOptions.maxTotalSize)}`,
      };
    }

    // Add chunk
    job.chunks.push(processedChunk);
    job.totalSize = newTotalSize;
    job.lastUpdated = Date.now();

    return {
      success: true,
      added: true,
      newSize: job.totalSize,
    };
  }

  /**
   * Finalize an assembly job and return the complete HTML
   */
  finalizeJob(jobId: string): { success: boolean; html?: string; blob?: Blob; stats?: AssemblyStats; reason?: string } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        success: false,
        reason: `Job ${jobId} not found`,
      };
    }

    try {
      // Efficiently join skeleton and chunks
      const parts = job.skeleton.split(job.insertionPoint);
      const content = [parts[0], ...job.chunks, job.insertionPoint, parts[1] || ''];
      const finalHtml = content.join('');
      
      // Create blob for efficient handling
      const blob = new Blob([finalHtml], { type: 'text/html;charset=UTF-8' });
      
      // Calculate stats
      const stats: AssemblyStats = {
        totalChunks: job.chunks.length,
        totalSize: job.totalSize,
        duplicateChunks: 0, // We don't track this directly, but could be added
        compressionRatio: job.chunks.length > 0 ? finalHtml.length / job.totalSize : 1,
        estimatedFinalSize: finalHtml.length,
      };

      // Clean up job
      this.jobs.delete(jobId);

      return {
        success: true,
        html: finalHtml,
        blob,
        stats,
      };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get job statistics
   */
  getJobStats(jobId: string): { success: boolean; stats?: AssemblyStats; reason?: string } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        success: false,
        reason: `Job ${jobId} not found`,
      };
    }

    const stats: AssemblyStats = {
      totalChunks: job.chunks.length,
      totalSize: job.totalSize,
      duplicateChunks: 0, // Could be calculated if needed
      compressionRatio: 1, // Will be calculated on finalization
      estimatedFinalSize: job.totalSize + job.skeleton.length,
    };

    return {
      success: true,
      stats,
    };
  }

  /**
   * Clean up old jobs to prevent memory leaks
   */
  cleanup(maxAge: number = 30 * 60 * 1000): number { // 30 minutes default
    const now = Date.now();
    let cleaned = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (now - job.lastUpdated > maxAge) {
        this.jobs.delete(jobId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get all active jobs
   */
  getActiveJobs(): Array<{ id: string; stats: AssemblyStats }> {
    const activeJobs: Array<{ id: string; stats: AssemblyStats }> = [];

    for (const [jobId, job] of this.jobs.entries()) {
      const stats: AssemblyStats = {
        totalChunks: job.chunks.length,
        totalSize: job.totalSize,
        duplicateChunks: 0,
        compressionRatio: 1,
        estimatedFinalSize: job.totalSize + job.skeleton.length,
      };

      activeJobs.push({ id: jobId, stats });
    }

    return activeJobs;
  }

  /**
   * Ensure the skeleton has the insertion point
   */
  private ensureInsertionPoint(skeleton: string, insertionPoint: string): string {
    if (skeleton.includes(insertionPoint)) {
      return skeleton;
    }

    // Try to find a good insertion point
    if (insertionPoint === '</body>' && skeleton.includes('</body>')) {
      return skeleton;
    }

    if (skeleton.includes('</html>')) {
      return skeleton.replace('</html>', `${insertionPoint}\n</html>`);
    }

    // Fallback: append at the end
    return skeleton + insertionPoint;
  }

  /**
   * Simple HTML minification
   */
  private minifyHtml(html: string): string {
    return html
      .replace(/\s+/g, ' ') // Replace multiple whitespace with single space
      .replace(/>\s+</g, '><') // Remove whitespace between tags
      .trim();
  }

  /**
   * Generate a hash for chunk deduplication.
   * Uses a two-accumulator approach for a wider effective bit-width (~53 bits)
   * than a single 32-bit djb2, reducing collision probability for large chunk sets.
   * (S2 improvement: replaces the original 32-bit hash.)
   */
  private generateHash(content: string): string {
    let h1 = 0x811c9dc5; // FNV offset basis
    let h2 = 0xdeadbeef;
    for (let i = 0; i < content.length; i++) {
      const c = content.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193); // FNV prime
      h2 = Math.imul(h2 ^ c, 0x9e3779b9); // Fibonacci hashing constant
    }
    // Combine into a hex string (up to 16 hex chars ≈ 64 bits effective)
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16));
  }

  /**
   * Get memory usage summary
   */
  getMemorySummary(): string {
    const activeJobs = this.getActiveJobs();
    const totalMemory = activeJobs.reduce((sum, job) => sum + job.stats.totalSize, 0);
    
    return `HTML Assembler: ${activeJobs.length} active jobs, ${adaptiveMemoryManager.formatBytes(totalMemory)} total memory used`;
  }
}

// Export singleton instance
export const htmlAssembler = new HtmlAssembler();
/**
 * Streaming Downloader - Handles large file downloads with chunked processing
 * Implements memory-efficient streaming with resume capability and progress tracking
 */

import {
  StreamingDownload,
  StreamingOptions,
  StreamingProgress,
  ChunkInfo,
  StreamingEventListeners,
  ProgressPersistence,
  MemoryPressureInfo,
  DEFAULT_STREAMING_OPTIONS,
  MEMORY_THRESHOLDS,
} from '../types/streaming';

import { memoryManager } from './MemoryManager';

export class StreamingDownloader {
  private activeDownloads: Map<string, StreamingDownload> = new Map();
  private eventListeners: StreamingEventListeners = {};
  private persistence: ProgressPersistence;
  private options: StreamingOptions;
  private memoryMonitorInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    persistence: ProgressPersistence,
    options: Partial<StreamingOptions> = {}
  ) {
    this.persistence = persistence;
    this.options = { ...DEFAULT_STREAMING_OPTIONS, ...options };
    this.startMemoryMonitoring();
    this.startCleanupTimer();
  }

  /**
   * Start a streaming download
   */
  async startDownload(
    url: string,
    options: Partial<StreamingOptions> = {}
  ): Promise<StreamingDownload> {
    const downloadOptions = { ...this.options, ...options };
    const downloadId = this.generateDownloadId(url);

    // Check if download can be resumed
    const existingDownload = downloadOptions.enableResumption
      ? await this.persistence.loadProgress(downloadId)
      : null;

    let download: StreamingDownload;

    if (existingDownload && existingDownload.status === 'streaming') {
      // Resume existing download
      download = existingDownload;
      download.status = 'resuming';
      await this.updateDownload(download);
    } else {
      // Create new download
      download = await this.createDownload(url, downloadId, downloadOptions);
    }

    this.activeDownloads.set(downloadId, download);
    this.eventListeners.onStart?.(download);

    try {
      if (download.status === 'resuming') {
        await this.resumeDownloadFromStorage(download);
      } else {
        await this.executeDownload(download);
      }
    } catch (error) {
      download.status = 'failed';
      download.error = error instanceof Error ? error.message : 'Unknown error';
      await this.updateDownload(download);
      this.eventListeners.onError?.(download, error as Error);
      throw error;
    }

    return download;
  }

  /**
   * Pause a streaming download
   */
  async pauseDownload(downloadId: string): Promise<void> {
    const download = this.activeDownloads.get(downloadId);
    if (!download) {
      throw new Error(`Download not found: ${downloadId}`);
    }

    download.status = 'paused';
    await this.updateDownload(download);
    this.eventListeners.onPause?.(download);
  }

  /**
   * Resume a paused download
   */
  async resumeDownload(downloadId: string): Promise<void> {
    const download = this.activeDownloads.get(downloadId);
    if (!download) {
      throw new Error(`Download not found: ${downloadId}`);
    }

    if (download.status !== 'paused') {
      throw new Error(`Cannot resume download in status: ${download.status}`);
    }

    download.status = 'resuming';
    await this.updateDownload(download);
    this.eventListeners.onResume?.(download);

    await this.executeDownload(download);
  }

  /**
   * Cancel a streaming download
   */
  async cancelDownload(downloadId: string): Promise<void> {
    const download = this.activeDownloads.get(downloadId);
    if (!download) {
      return;
    }

    download.status = 'aborted';
    await this.updateDownload(download);
    this.activeDownloads.delete(downloadId);
    await this.persistence.removeProgress(downloadId);
  }

  /**
   * Get download progress
   */
  getProgress(downloadId: string): StreamingProgress | null {
    const download = this.activeDownloads.get(downloadId);
    if (!download) {
      return null;
    }

    const completedChunks = download.chunks.filter(chunk => chunk.downloaded).length;
    const downloadSpeed = this.calculateDownloadSpeed(download);
    const eta = this.calculateETA(download, downloadSpeed);

    return {
      downloadId,
      completedChunks,
      totalChunks: download.chunks.length,
      bytesDownloaded: download.downloadedSize,
      totalBytes: download.totalSize,
      downloadSpeed,
      eta,
      status: download.status,
    };
  }

  /**
   * Get all active downloads
   */
  getActiveDownloads(): StreamingDownload[] {
    return Array.from(this.activeDownloads.values());
  }

  /**
   * Check if download should use streaming
   */
  shouldUseStreaming(
    url: string,
    fileSize?: number,
    options: Partial<StreamingOptions> = {}
  ): boolean {
    const opts = { ...this.options, ...options };

    if (opts.forceStreaming) {
      return true;
    }

    if (fileSize && fileSize >= opts.streamingThreshold!) {
      return true;
    }

    // Check content type for files that typically benefit from streaming
    const streamingExtensions = [
      '.zip', '.rar', '.7z', '.tar', '.gz',
      '.mp4', '.avi', '.mkv', '.mov', '.wmv',
      '.mp3', '.wav', '.flac', '.aac',
      '.pdf', '.psd', '.ai', '.eps',
      '.iso', '.dmg', '.img'
    ];

    return streamingExtensions.some(ext =>
      url.toLowerCase().includes(ext)
    );
  }

  /**
   * Create a new download object
   */
  private async createDownload(
    url: string,
    downloadId: string,
    options: StreamingOptions
  ): Promise<StreamingDownload> {
    // Try to get file size first
    let totalSize = 0;
    let mimeType: string | undefined;
    let filename: string | undefined;

    try {
      const headResponse = await fetch(url, { method: 'HEAD' });
      const contentLength = headResponse.headers.get('Content-Length');
      const contentType = headResponse.headers.get('Content-Type');
      const contentDisposition = headResponse.headers.get('Content-Disposition');

      totalSize = contentLength ? parseInt(contentLength) : 0;
      mimeType = contentType || undefined;

      // Extract filename from Content-Disposition if available
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch) {
          filename = filenameMatch[1].replace(/['"]/g, '');
        }
      }

      if (!filename) {
        // Extract filename from URL
        const urlParts = new URL(url);
        filename = urlParts.pathname.split('/').pop() || 'download';
      }
    } catch (error) {
      console.warn('Could not get file metadata:', error);
    }

    const chunkSize = this.calculateOptimalChunkSize(totalSize, options);
    const totalChunks = Math.ceil(totalSize / chunkSize);

    const chunks: ChunkInfo[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);

      chunks.push({
        index: i,
        start,
        end,
        size: end - start + 1,
        downloaded: false,
        retryCount: 0,
      });
    }

    const download: StreamingDownload = {
      id: downloadId,
      url,
      totalSize,
      downloadedSize: 0,
      progress: 0,
      chunks,
      status: 'pending',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      mimeType,
      filename,
      resumable: options.enableResumption!,
      activeChunks: 0,
      chunkSize,
    };

    return download;
  }

  /**
   * Execute the download with chunked processing
   */
  private async executeDownload(download: StreamingDownload): Promise<void> {
    download.status = 'starting';
    await this.updateDownload(download);

    const pendingChunks = download.chunks.filter(chunk => !chunk.downloaded);
    // Initial parallelism
    let currentMaxParallel = Math.min(
      this.options.maxParallelChunks!,
      pendingChunks.length
    );

    download.status = 'streaming';
    download.activeChunks = currentMaxParallel;
    await this.updateDownload(download);

    // Download chunks in parallel batches
    const chunkPromises: Promise<void>[] = [];
    let chunkIndex = 0;

    while (chunkIndex < pendingChunks.length) {
      // Fill up the batch
      while (
        chunkPromises.length < download.activeChunks &&
        chunkIndex < pendingChunks.length
      ) {
        const chunk = pendingChunks[chunkIndex];
        chunkPromises.push(this.downloadChunk(download, chunk));
        chunkIndex++;
      }

      // Wait for at least one chunk to complete
      await Promise.race(chunkPromises);

      // Remove completed chunks from the batch
      const completedIndices: number[] = [];
      for (let i = 0; i < chunkPromises.length; i++) {
        if (await this.isPromiseSettled(chunkPromises[i])) {
          completedIndices.push(i);
        }
      }

      // Remove completed promises in reverse order to maintain indices
      for (let i = completedIndices.length - 1; i >= 0; i--) {
        chunkPromises.splice(completedIndices[i], 1);
      }

      // Check memory pressure and adjust parallelism if needed
      if (this.options.monitorMemory) {
        await this.adjustForMemoryPressure(download);
      }

      // Dynamic concurrency scaling based on throughput
      this.adjustConcurrency(download);
    }

    // Wait for all remaining chunks to complete
    await Promise.all(chunkPromises);

    // Mark download as complete
    download.status = 'completed';
    download.completedAt = Date.now();
    download.progress = 1.0;
    download.activeChunks = 0;
    await this.updateDownload(download);

    this.eventListeners.onComplete?.(download);
  }

  /**
   * Download a single chunk
   */
  private async downloadChunk(
    download: StreamingDownload,
    chunk: ChunkInfo
  ): Promise<void> {
    const maxRetries = this.options.maxRetries!;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, this.options.chunkTimeout!);

        const response = await fetch(download.url, {
          signal: controller.signal,
          headers: {
            Range: `bytes=${chunk.start}-${chunk.end}`,
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        chunk.data = arrayBuffer as any; // Type assertion to handle ArrayBuffer vs Blob type mismatch
        chunk.downloaded = true;
        chunk.downloadedAt = Date.now();

        // Update download progress
        download.downloadedSize += chunk.size;
        download.progress = download.totalSize > 0
          ? download.downloadedSize / download.totalSize
          : 0;
        download.updatedAt = Date.now();

        // Calculate checksum if enabled
        if (this.options.enableChecksums) {
          chunk.checksum = await this.calculateChecksum(arrayBuffer);
        }

        await this.updateDownload(download);
        this.eventListeners.onChunkProgress?.(download, chunk);

        return;
      } catch (error) {
        lastError = error as Error;
        chunk.retryCount = attempt + 1;

        if (attempt < maxRetries) {
          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed
    throw lastError || new Error(`Failed to download chunk ${chunk.index}`);
  }

  /**
   * Resume an interrupted download
   */
  private async resumeDownloadFromStorage(download: StreamingDownload): Promise<void> {
    // Validate existing chunks
    const validChunks = await this.validateExistingChunks(download);
    download.chunks = validChunks;
    download.downloadedSize = validChunks
      .filter(chunk => chunk.downloaded)
      .reduce((sum, chunk) => sum + chunk.size, 0);

    download.progress = download.totalSize > 0
      ? download.downloadedSize / download.totalSize
      : 0;

    await this.executeDownload(download);
  }

  /**
   * Validate existing chunks in a resumed download
   */
  private async validateExistingChunks(
    download: StreamingDownload
  ): Promise<ChunkInfo[]> {
    const validChunks: ChunkInfo[] = [];

    for (const chunk of download.chunks) {
      if (chunk.downloaded && chunk.data) {
        // Validate chunk data integrity if checksum is available
        if (this.options.enableChecksums && chunk.checksum) {
          const isValid = await this.validateChunkChecksum(chunk);
          if (isValid) {
            validChunks.push(chunk);
          } else {
            // Mark as not downloaded if checksum fails
            validChunks.push({
              ...chunk,
              downloaded: false,
              data: undefined,
              checksum: undefined,
              retryCount: 0,
            });
          }
        } else {
          validChunks.push(chunk);
        }
      } else {
        validChunks.push(chunk);
      }
    }

    return validChunks;
  }

  /**
   * Calculate optimal chunk size based on file size and memory constraints
   */
  private calculateOptimalChunkSize(
    fileSize: number,
    options: StreamingOptions
  ): number {
    const baseChunkSize = options.chunkSize!;

    // Adjust based on file size
    if (fileSize > 100 * 1024 * 1024) { // > 100MB
      return Math.min(baseChunkSize * 2, 5 * 1024 * 1024); // Max 5MB
    } else if (fileSize > 10 * 1024 * 1024) { // > 10MB
      return baseChunkSize;
    } else {
      return Math.max(baseChunkSize / 2, 256 * 1024); // Min 256KB
    }
  }

  /**
   * Generate a unique download ID
   */
  private generateDownloadId(url: string): string {
    const urlHash = this.simpleHash(url);
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `stream-${urlHash}-${timestamp}-${random}`;
  }

  /**
   * Simple hash function for URLs
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Update download and persist progress
   */
  private async updateDownload(download: StreamingDownload): Promise<void> {
    if (this.options.enablePersistence) {
      await this.persistence.saveProgress(download);
    }
  }

  /**
   * Calculate download speed
   */
  private calculateDownloadSpeed(download: StreamingDownload): number {
    const timeElapsed = Date.now() - download.startedAt;
    if (timeElapsed === 0) return 0;
    return (download.downloadedSize * 1000) / timeElapsed; // bytes per second
  }

  /**
   * Calculate estimated time remaining
   */
  private calculateETA(download: StreamingDownload, speed: number): number {
    if (speed === 0 || download.totalSize === 0) return 0;
    const remainingBytes = download.totalSize - download.downloadedSize;
    return remainingBytes / speed; // seconds
  }

  /**
   * Start memory monitoring
   */
  private startMemoryMonitoring(): void {
    if (!this.options.monitorMemory) return;

    this.memoryMonitorInterval = setInterval(async () => {
      const pressure = this.getMemoryPressure();
      if (pressure.level !== 'low') {
        this.eventListeners.onMemoryPressure?.(pressure);
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Get current memory pressure
   */
  private getMemoryPressure(): MemoryPressureInfo {
    const memoryStats = memoryManager.getMemoryStats();
    const percentageUsed = memoryStats.memoryPressureLevel === 'critical' ? 1 :
                          memoryStats.memoryPressureLevel === 'high' ? 0.9 :
                          memoryStats.memoryPressureLevel === 'medium' ? 0.8 : 0.6;

    let level: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (percentageUsed >= MEMORY_THRESHOLDS.CRITICAL) {
      level = 'critical';
    } else if (percentageUsed >= MEMORY_THRESHOLDS.HIGH) {
      level = 'high';
    } else if (percentageUsed >= MEMORY_THRESHOLDS.MEDIUM) {
      level = 'medium';
    }

    return {
      level,
      bytesUsed: memoryStats.totalMemoryUsed,
      bytesLimit: memoryStats.totalMemoryLimit,
      percentageUsed,
      shouldPause: level === 'critical',
      shouldReduceParallelism: level === 'high' || level === 'critical',
    };
  }

  /**
   * Adjust download parallelism based on memory pressure
   */
  private async adjustForMemoryPressure(download: StreamingDownload): Promise<void> {
    const pressure = this.getMemoryPressure();

    if (pressure.shouldPause) {
      await this.pauseDownload(download.id);
    } else if (pressure.shouldReduceParallelism && download.activeChunks > 1) {
      // Reduce parallelism
      download.activeChunks = Math.max(1, Math.floor(download.activeChunks / 2));
      await this.updateDownload(download);
    }
  }

  /**
   * Adjust concurrency based on network throughput
   */
  private adjustConcurrency(download: StreamingDownload): void {
    const speed = this.calculateDownloadSpeed(download); // bytes per second
    const currentParallelism = download.activeChunks;
    const maxConfigured = this.options.maxParallelChunks!;

    // Thresholds for scaling (arbitrary example values, can be tuned)
    // If speed > 5 MB/s and we are not at max parallelism, increase
    if (speed > 5 * 1024 * 1024 && currentParallelism < maxConfigured) {
      download.activeChunks = Math.min(currentParallelism + 1, maxConfigured);
    }
    // If speed < 500 KB/s and we have high parallelism, decrease to reduce overhead
    else if (speed < 500 * 1024 && currentParallelism > 2) {
      download.activeChunks = Math.max(2, currentParallelism - 1);
    }
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupOldDownloads();
    }, 60000); // Clean up every minute
  }

  /**
   * Clean up old downloads
   */
  private async cleanupOldDownloads(): Promise<void> {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    for (const [downloadId, download] of this.activeDownloads.entries()) {
      const age = now - download.updatedAt;

      if (
        age > maxAge &&
        (download.status === 'completed' || download.status === 'failed')
      ) {
        this.activeDownloads.delete(downloadId);
        await this.persistence.removeProgress(downloadId);
      }
    }
  }

  /**
   * Calculate checksum for data integrity
   */
  private async calculateChecksum(data: ArrayBuffer): Promise<string> {
    // Simple checksum implementation - in production, use crypto.subtle.digest
    const view = new Uint8Array(data);
    let hash = 0;
    for (let i = 0; i < view.length; i++) {
      hash = ((hash << 5) - hash + view[i]) & 0xffffffff;
    }
    return hash.toString(16);
  }

  /**
   * Validate chunk checksum
   */
  private async validateChunkChecksum(chunk: ChunkInfo): Promise<boolean> {
    if (!chunk.data || !chunk.checksum) return false;

    const calculatedChecksum = await this.calculateChecksum(
      chunk.data instanceof ArrayBuffer ? chunk.data :
      await (chunk.data as Blob).arrayBuffer()
    );

    return calculatedChecksum === chunk.checksum;
  }

  /**
   * Check if a promise is settled
   */
  private async isPromiseSettled(promise: Promise<any>): Promise<boolean> {
    try {
      await Promise.race([promise, Promise.resolve('pending')]);
      return promise !== Promise.resolve('pending');
    } catch {
      return true;
    }
  }

  /**
   * Set event listeners
   */
  setEventListeners(listeners: StreamingEventListeners): void {
    this.eventListeners = { ...this.eventListeners, ...listeners };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
      this.memoryMonitorInterval = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.activeDownloads.clear();
  }
}
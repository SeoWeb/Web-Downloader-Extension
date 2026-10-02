/**
 * Streaming Downloader - Handles large file downloads with chunked processing
 * Implements memory-efficient streaming with resume capability and progress tracking
 */

import {
  StreamingDownload,
  StreamingOptions,
  StreamingProgress,
  StreamingEventListeners,
  ProgressPersistence,
  DEFAULT_STREAMING_OPTIONS,
} from "../types/streaming";
import {
  generateDownloadId,
  calculateETA,
  calculateDownloadSpeed,
} from "./streaming/utils";
import {
  calculateOptimalChunkSize,
  generateChunks,
  validateExistingChunks,
} from "./streaming/chunk";
import { MemoryMonitor } from "./streaming/memory";
import { DownloadTask } from "./streaming/DownloadTask";

export class StreamingDownloader {
  private activeDownloads: Map<string, StreamingDownload> = new Map();
  private eventListeners: StreamingEventListeners = {};
  private persistence: ProgressPersistence;
  private options: StreamingOptions;
  private memoryMonitor: MemoryMonitor;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    persistence: ProgressPersistence,
    options: Partial<StreamingOptions> = {},
  ) {
    this.persistence = persistence;
    this.options = { ...DEFAULT_STREAMING_OPTIONS, ...options };
    this.memoryMonitor = new MemoryMonitor(this.options.monitorMemory);

    // Start memory monitoring with listener
    this.memoryMonitor.start((pressure) => {
      this.eventListeners.onMemoryPressure?.(pressure);
    });

    this.startCleanupTimer();
  }

  /**
   * Start a streaming download
   */
  async startDownload(
    url: string,
    options: Partial<StreamingOptions> = {},
  ): Promise<StreamingDownload> {
    const downloadOptions = { ...this.options, ...options };
    const downloadId = generateDownloadId(url);

    // Check if download can be resumed
    const existingDownload = downloadOptions.enableResumption
      ? await this.persistence.loadProgress(downloadId)
      : null;

    let download: StreamingDownload;

    if (existingDownload && existingDownload.status === "streaming") {
      // Resume existing download
      download = existingDownload;
      download.status = "resuming";
      await this.updateDownload(download);
    } else {
      // Create new download
      download = await this.createDownload(url, downloadId, downloadOptions);
    }

    this.activeDownloads.set(downloadId, download);
    this.eventListeners.onStart?.(download);

    try {
      if (download.status === "resuming") {
        const validChunks = await validateExistingChunks(
          download,
          downloadOptions,
        );
        download.chunks = validChunks;
        download.downloadedSize = validChunks
          .filter((chunk) => chunk.downloaded)
          .reduce((sum, chunk) => sum + chunk.size, 0);

        download.progress =
          download.totalSize > 0
            ? download.downloadedSize / download.totalSize
            : 0;

        await this.runTask(download, downloadOptions);
      } else {
        await this.runTask(download, downloadOptions);
      }
    } catch (error) {
      download.status = "failed";
      download.error = error instanceof Error ? error.message : "Unknown error";
      await this.updateDownload(download);
      this.eventListeners.onError?.(download, error as Error);
      throw error;
    }

    return download;
  }

  private async runTask(
    download: StreamingDownload,
    options: StreamingOptions,
  ) {
    const task = new DownloadTask({
      download,
      options,
      persistence: { saveProgress: (d) => this.persistence.saveProgress(d) },
      eventListeners: this.eventListeners,
      memoryMonitor: this.memoryMonitor,
    });
    await task.execute();
  }

  /**
   * Pause a streaming download
   */
  async pauseDownload(downloadId: string): Promise<void> {
    const download = this.activeDownloads.get(downloadId);
    if (!download) {
      throw new Error(`Download not found: ${downloadId}`);
    }

    download.status = "paused";
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

    if (download.status !== "paused") {
      throw new Error(`Cannot resume download in status: ${download.status}`);
    }

    download.status = "resuming";
    await this.updateDownload(download);
    this.eventListeners.onResume?.(download);

    const validChunks = await validateExistingChunks(download, this.options);
    download.chunks = validChunks;
    // Recalculate size just in case? Or assume valdiateExistingChunks preserved them
    // Original resumeDownloadFromStorage recalculated:
    download.downloadedSize = validChunks
      .filter((chunk) => chunk.downloaded)
      .reduce((sum, chunk) => sum + chunk.size, 0);
    download.progress =
      download.totalSize > 0 ? download.downloadedSize / download.totalSize : 0;

    await this.runTask(download, this.options);
  }

  /**
   * Cancel a streaming download
   */
  async cancelDownload(downloadId: string): Promise<void> {
    const download = this.activeDownloads.get(downloadId);
    if (!download) {
      return;
    }

    download.status = "aborted";
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

    const completedChunks = download.chunks.filter(
      (chunk) => chunk.downloaded,
    ).length;
    const downloadSpeed = calculateDownloadSpeed(download);
    const eta = calculateETA(download, downloadSpeed);

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
    options: Partial<StreamingOptions> = {},
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
      ".zip",
      ".rar",
      ".7z",
      ".tar",
      ".gz",
      ".mp4",
      ".avi",
      ".mkv",
      ".mov",
      ".wmv",
      ".mp3",
      ".wav",
      ".flac",
      ".aac",
      ".pdf",
      ".psd",
      ".ai",
      ".eps",
      ".iso",
      ".dmg",
      ".img",
    ];

    return streamingExtensions.some((ext) => url.toLowerCase().includes(ext));
  }

  /**
   * Create a new download object
   */
  private async createDownload(
    url: string,
    downloadId: string,
    options: StreamingOptions,
  ): Promise<StreamingDownload> {
    // Try to get file size first
    let totalSize = 0;
    let mimeType: string | undefined;
    let filename: string | undefined;

    try {
      const headResponse = await fetch(url, { method: "HEAD" });
      const contentLength = headResponse.headers.get("Content-Length");
      const contentType = headResponse.headers.get("Content-Type");
      const contentDisposition = headResponse.headers.get(
        "Content-Disposition",
      );

      totalSize = contentLength ? parseInt(contentLength) : 0;
      mimeType = contentType || undefined;

      // Extract filename from Content-Disposition if available
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(
          /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/,
        );
        if (filenameMatch) {
          filename = filenameMatch[1].replace(/['"]/g, "");
        }
      }

      if (!filename) {
        // Extract filename from URL
        const urlParts = new URL(url);
        filename = urlParts.pathname.split("/").pop() || "download";
      }
    } catch {
      // Ignore
    }

    const chunkSize = calculateOptimalChunkSize(totalSize, options);
    const chunks = generateChunks(totalSize, chunkSize);

    const download: StreamingDownload = {
      id: downloadId,
      url,
      totalSize,
      downloadedSize: 0,
      progress: 0,
      chunks,
      status: "pending",
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
   * Update download and persist progress
   */
  private async updateDownload(download: StreamingDownload): Promise<void> {
    if (this.options.enablePersistence) {
      await this.persistence.saveProgress(download);
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
        (download.status === "completed" || download.status === "failed")
      ) {
        this.activeDownloads.delete(downloadId);
        await this.persistence.removeProgress(downloadId);
      }
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
    this.memoryMonitor.stop();

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.activeDownloads.clear();
  }
}

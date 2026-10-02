import {
  StreamingDownload,
  StreamingOptions,
  ChunkInfo,
  StreamingEventListeners,
} from "../../types/streaming";
import {
  calculateDownloadSpeed,
  isPromiseSettled,
  calculateChecksum,
} from "./utils";
import { MemoryMonitor } from "./memory";

export type TaskContext = {
  download: StreamingDownload;
  options: StreamingOptions;
  persistence: { saveProgress: (d: StreamingDownload) => Promise<void> };
  eventListeners: StreamingEventListeners;
  memoryMonitor?: MemoryMonitor; // Optional, or accessed via global if preferred, but passing is cleaner
};

export class DownloadTask {
  constructor(private context: TaskContext) {}

  private get download() {
    return this.context.download;
  }
  private get options() {
    return this.context.options;
  }

  /**
   * Execute the download with chunked processing
   */
  public async execute(): Promise<void> {
    const { download } = this.context;

    download.status = "starting";
    await this.updateDownload();

    const pendingChunks = download.chunks.filter((chunk) => !chunk.downloaded);
    // Initial parallelism
    let currentMaxParallel = Math.min(
      this.options.maxParallelChunks!,
      pendingChunks.length,
    );

    download.status = "streaming";
    download.activeChunks = currentMaxParallel;
    await this.updateDownload();

    // Download chunks in parallel batches
    const chunkPromises: Promise<void>[] = [];
    let chunkIndex = 0;

    // We process chunks as long as we have pending chunks AND the status remains 'streaming'
    while (chunkIndex < pendingChunks.length) {
      // Check for pause/cancellation/failure
      if (download.status !== "streaming") {
        break;
      }

      // Fill up the batch
      while (
        chunkPromises.length < download.activeChunks &&
        chunkIndex < pendingChunks.length
      ) {
        // Double check status before starting new chunk
        if (download.status !== "streaming") break;

        const chunk = pendingChunks[chunkIndex];
        chunkPromises.push(this.downloadChunk(chunk));
        chunkIndex++;
      }

      // Wait for at least one chunk to complete
      if (chunkPromises.length > 0) {
        await Promise.race(chunkPromises);
      }

      // Remove completed chunks from the batch
      const completedIndices: number[] = [];
      for (let i = 0; i < chunkPromises.length; i++) {
        if (await isPromiseSettled(chunkPromises[i])) {
          completedIndices.push(i);
        }
      }

      // Remove completed promises in reverse order to maintain indices
      for (let i = completedIndices.length - 1; i >= 0; i--) {
        chunkPromises.splice(completedIndices[i], 1);
      }

      // Check memory pressure and adjust parallelism if needed
      if (this.context.options.monitorMemory && this.context.memoryMonitor) {
        await this.adjustForMemoryPressure();
      }

      // Dynamic concurrency scaling based on throughput
      this.adjustConcurrency();
    }

    // Wait for all remaining chunks to complete (existing requests finish even if paused)
    await Promise.all(chunkPromises);

    // If we finished all chunks, mark complete.
    // If we exited loop due to pause/abort, we do NOT mark complete.
    const allDownloaded = download.chunks.every((c) => c.downloaded);

    if (allDownloaded && download.status === "streaming") {
      download.status = "completed";
      download.completedAt = Date.now();
      download.progress = 1.0;
      download.activeChunks = 0;
      await this.updateDownload();
      this.context.eventListeners.onComplete?.(download);
    }
  }

  /**
   * Download a single chunk
   */
  private async downloadChunk(chunk: ChunkInfo): Promise<void> {
    const { download } = this.context;
    const maxRetries = this.options.maxRetries!;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // If download is no longer active (aborted/paused), stop retrying
      if (download.status !== "streaming" && download.status !== "starting") {
        return;
      }

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
        chunk.data = arrayBuffer as any; // Type assertion
        chunk.downloaded = true;
        chunk.downloadedAt = Date.now();

        // Update download progress
        download.downloadedSize += chunk.size;
        download.progress =
          download.totalSize > 0
            ? download.downloadedSize / download.totalSize
            : 0;
        download.updatedAt = Date.now();

        // Checksum calculation handles in ChunkManager/Executor or here?
        // Original has it here.
        if (this.options.enableChecksums) {
          chunk.checksum = await calculateChecksum(arrayBuffer);
        }

        await this.updateDownload();
        this.context.eventListeners.onChunkProgress?.(download, chunk);

        return;
      } catch (error) {
        lastError = error as Error;
        chunk.retryCount = attempt + 1;

        if (attempt < maxRetries) {
          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed
    // Only throw if we are still supposed to be streaming
    if (download.status === "streaming") {
      throw lastError || new Error(`Failed to download chunk ${chunk.index}`);
    }
  }

  private async updateDownload(): Promise<void> {
    if (this.options.enablePersistence) {
      await this.context.persistence.saveProgress(this.download);
    }
  }

  private async adjustForMemoryPressure(): Promise<void> {
    if (!this.context.memoryMonitor) return;

    const pressure = this.context.memoryMonitor.getMemoryPressure();
    const { download } = this.context;

    if (pressure.shouldPause) {
      // We invoke pause on the download object directly, but we also need to notify system?
      // In original: await this.pauseDownload(download.id);
      // Here we don't have access to 'pauseDownload' method of Manager.
      // But 'pauseDownload' just sets status and updates.
      download.status = "paused";
      await this.updateDownload();
      this.context.eventListeners.onPause?.(download);
    } else if (pressure.shouldReduceParallelism && download.activeChunks > 1) {
      // Reduce parallelism
      download.activeChunks = Math.max(
        1,
        Math.floor(download.activeChunks / 2),
      );
      await this.updateDownload();
    }
  }

  private adjustConcurrency(): void {
    const { download } = this.context;
    const speed = calculateDownloadSpeed(download);
    const currentParallelism = download.activeChunks;
    const maxConfigured = this.options.maxParallelChunks!;

    if (speed > 5 * 1024 * 1024 && currentParallelism < maxConfigured) {
      download.activeChunks = Math.min(currentParallelism + 1, maxConfigured);
    } else if (speed < 500 * 1024 && currentParallelism > 2) {
      download.activeChunks = Math.max(2, currentParallelism - 1);
    }
  }
}

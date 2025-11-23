/**
 * Chunked ZIP Processing Utilities
 * Provides memory-efficient ZIP creation with streaming capabilities
 */

import JSZip from 'jszip';
import {
  ChunkedZipOptions,
  DEFAULT_CHUNKED_ZIP_OPTIONS,
  StreamingDownload,
} from '../types/streaming';
import { memoryManager } from './MemoryManager';

export interface ZipEntry {
  /** Entry path within ZIP */
  path: string;
  /** File content as blob or array buffer */
  data: Blob | ArrayBuffer;
  /** Content type */
  mimeType?: string;
  /** Last modified timestamp */
  lastModified?: number;
  /** Whether to compress this entry */
  compress?: boolean;
}

export interface ZipCreationProgress {
  /** Total entries processed */
  totalEntries: number;
  /** Completed entries */
  completedEntries: number;
  /** Total bytes processed */
  totalBytes: number;
  /** Completed bytes */
  completedBytes: number;
  /** Current operation */
  currentOperation: 'adding' | 'compressing' | 'finalizing' | 'completed';
  /** Current entry being processed */
  currentEntry?: string;
}

export class ChunkedZipProcessor {
  private zip: any;
  private options: ChunkedZipOptions;
  private entries: ZipEntry[] = [];
  private processedEntries: ZipEntry[] = [];
  private currentProgress: ZipCreationProgress;

  constructor(options: Partial<ChunkedZipOptions> = {}) {
    this.options = { ...DEFAULT_CHUNKED_ZIP_OPTIONS, ...options };
    this.zip = new JSZip();
    this.currentProgress = {
      totalEntries: 0,
      completedEntries: 0,
      totalBytes: 0,
      completedBytes: 0,
      currentOperation: 'adding',
    };
  }

  /**
   * Add an entry to the ZIP
   */
  async addEntry(entry: ZipEntry): Promise<void> {
    // Check memory usage before adding large files
    const entrySize = await this.getEntrySize(entry);
    if (entrySize > this.options.maxMemoryUsage!) {
      throw new Error(`Entry too large for ZIP: ${entrySize} bytes`);
    }

    // Check if we should process in chunks
    if (this.options.progressive && this.shouldProcessInChunks()) {
      await this.processCurrentBatch();
    }

    this.entries.push(entry);
    this.currentProgress.totalEntries++;
    this.currentProgress.totalBytes += entrySize;
  }

  /**
   * Add multiple entries efficiently
   */
  async addEntries(entries: ZipEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.addEntry(entry);
    }
  }

  /**
   * Generate the final ZIP file
   */
  async generateZip(): Promise<Blob> {
    this.currentProgress.currentOperation = 'finalizing';

    // Process any remaining entries
    if (this.entries.length > 0) {
      await this.processCurrentBatch();
    }

    // Generate the ZIP with memory monitoring
    const generateOptions = {
      type: 'blob' as const,
      compression: this.options.compressionLevel !== undefined
        ? 'DEFLATE' as const
        : 'STORE' as const,
      compressionOptions: this.options.compressionLevel !== undefined
        ? { level: this.options.compressionLevel }
        : undefined,
      streamFiles: this.options.enableStreaming,
    };

    // Monitor memory during ZIP generation
    const memoryBefore = memoryManager.getMemoryStats().totalMemoryUsed;
    const maxAllowedMemory = this.options.maxMemoryUsage!;

    try {
      const zipBlob = await this.zip.generateAsync(generateOptions, (metadata: any) => {
        this.currentProgress.completedBytes = metadata.percent / 100 * this.currentProgress.totalBytes;

        // Check memory pressure during generation
        const currentMemory = memoryManager.getMemoryStats().totalMemoryUsed;
        const memoryIncrease = currentMemory - memoryBefore;

        if (memoryIncrease > maxAllowedMemory * 0.8) {
          console.warn('High memory usage during ZIP generation, consider reducing compression');
          memoryManager.forceCleanup();
        }
      });

      this.currentProgress.currentOperation = 'completed';
      this.currentProgress.completedEntries = this.currentProgress.totalEntries;
      this.currentProgress.completedBytes = this.currentProgress.totalBytes;

      return zipBlob;
    } catch (error) {
      console.error('Error generating ZIP:', error);
      throw new Error(`ZIP generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate ZIP in streaming mode for large files
   */
  async generateZipStream(): Promise<ReadableStream> {
    if (!this.options.enableStreaming) {
      throw new Error('Streaming is not enabled in options');
    }

    this.currentProgress.currentOperation = 'finalizing';

    // Process remaining entries
    if (this.entries.length > 0) {
      await this.processCurrentBatch();
    }

    // Create a streaming ZIP generator
    const self = this;
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // For streaming ZIP, we'll use chunked generation
          const chunkSize = self.options.zipChunkSize!;
          let offset = 0;

          while (offset < self.currentProgress.totalBytes) {
            const chunk = await self.generateZipChunk(offset, chunkSize);
            controller.enqueue(chunk);
            offset += chunkSize;

            // Update progress
            self.currentProgress.completedBytes = Math.min(offset, self.currentProgress.totalBytes);
          }

          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });

    return stream;
  }

  /**
   * Add streaming download to ZIP
   */
  async addStreamingDownload(
    download: StreamingDownload,
    zipPath: string
  ): Promise<void> {
    if (download.status !== 'completed') {
      throw new Error('Download must be completed before adding to ZIP');
    }

    // Combine all chunks into a single blob
    const chunks = download.chunks
      .filter(chunk => chunk.downloaded && chunk.data)
      .sort((a, b) => a.index - b.index);

    if (chunks.length === 0) {
      throw new Error('No valid chunks found for download');
    }

    // Create blob from all chunks
    const blobParts: ArrayBuffer[] = [];
    for (const chunk of chunks) {
      if (chunk.data) {
        const arrayBuffer = chunk.data instanceof ArrayBuffer
          ? chunk.data
          : await (chunk.data as Blob).arrayBuffer();
        blobParts.push(arrayBuffer);
      }
    }

    const combinedBlob = new Blob(blobParts, { type: download.mimeType });

    await this.addEntry({
      path: zipPath,
      data: combinedBlob,
      mimeType: download.mimeType,
      lastModified: download.completedAt || Date.now(),
      compress: !this.isAlreadyCompressed(download.mimeType),
    });
  }

  /**
   * Get current progress
   */
  getProgress(): ZipCreationProgress {
    return { ...this.currentProgress };
  }

  /**
   * Clear all entries and reset progress
   */
  reset(): void {
    this.entries = [];
    this.processedEntries = [];
    this.zip = new JSZip();
    this.currentProgress = {
      totalEntries: 0,
      completedEntries: 0,
      totalBytes: 0,
      completedBytes: 0,
      currentOperation: 'adding',
    };
  }

  /**
   * Estimate final ZIP size
   */
  estimateFinalSize(): number {
    const uncompressedSize = this.currentProgress.totalBytes;
    const compressionRatio = this.options.compressionLevel
      ? Math.max(0.3, 1 - (this.options.compressionLevel * 0.1))
      : 1.0;

    return Math.round(uncompressedSize * compressionRatio * 1.1); // 10% overhead
  }

  /**
   * Process current batch of entries
   */
  private async processCurrentBatch(): Promise<void> {
    this.currentProgress.currentOperation = 'adding';

    for (const entry of this.entries) {
      this.currentProgress.currentEntry = entry.path;

      try {
        await this.addEntryToZip(entry);
        this.processedEntries.push(entry);
        this.currentProgress.completedEntries++;
        this.currentProgress.completedBytes += await this.getEntrySize(entry);
      } catch (error) {
        console.error(`Error adding entry ${entry.path}:`, error);
        throw error;
      }
    }

    // Clear processed entries from memory
    this.entries = [];

    // Perform memory cleanup if needed
    if (this.options.maxMemoryUsage) {
      const currentUsage = memoryManager.getMemoryStats().totalMemoryUsed;
      if (currentUsage > this.options.maxMemoryUsage * 0.7) {
        await memoryManager.forceCleanup();
      }
    }
  }

  /**
   * Add a single entry to the JSZip instance
   */
  private async addEntryToZip(entry: ZipEntry): Promise<void> {
    const zipOptions: any = {
      compression: entry.compress !== false ? 'DEFLATE' : 'STORE',
      compressionOptions: entry.compress !== false
        ? { level: this.options.compressionLevel || 6 }
        : undefined,
      date: entry.lastModified ? new Date(entry.lastModified) : new Date(),
    };

    // Convert data to appropriate format for JSZip
    let data: string | ArrayBuffer | Blob;

    if (entry.data instanceof ArrayBuffer) {
      data = entry.data;
    } else if (entry.data instanceof Blob) {
      // For large blobs, consider streaming
      if (entry.data.size > 10 * 1024 * 1024) { // 10MB
        data = await entry.data.arrayBuffer();
      } else {
        data = entry.data;
      }
    } else {
      data = entry.data;
    }

    this.zip.file(entry.path, data, zipOptions);
  }

  /**
   * Check if we should process entries in chunks
   */
  private shouldProcessInChunks(): boolean {
    return this.entries.length >= 50 || // Number of entries
           this.currentProgress.totalBytes >= 50 * 1024 * 1024; // 50MB total
  }

  /**
   * Get entry size in bytes
   */
  private async getEntrySize(entry: ZipEntry): Promise<number> {
    if (entry.data instanceof ArrayBuffer) {
      return entry.data.byteLength;
    } else if (entry.data instanceof Blob) {
      return entry.data.size;
    } else {
      // Convert to blob to get size
      const blob = new Blob([entry.data]);
      return blob.size;
    }
  }

  /**
   * Check if file type is already compressed
   */
  private isAlreadyCompressed(mimeType?: string): boolean {
    if (!mimeType) return false;

    const compressedTypes = [
      'application/zip',
      'application/gzip',
      'application/x-gzip',
      'application/x-7z-compressed',
      'application/x-rar-compressed',
      'application/x-bzip',
      'application/x-bzip2',
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/ogg',
    ];

    return compressedTypes.some(type => mimeType.includes(type));
  }

  /**
   * Generate a chunk of the ZIP for streaming
   */
  private async generateZipChunk(offset: number, size: number): Promise<ArrayBuffer> {
    // This is a simplified implementation
    // In a real implementation, you would use a streaming ZIP library
    // or implement ZIP format streaming manually

    const chunkSize = Math.min(size, this.options.zipChunkSize!);

    // For now, generate the entire ZIP and extract a chunk
    // This is not memory efficient but demonstrates the concept
    const fullZip = await this.generateZip();
    const arrayBuffer = await fullZip.arrayBuffer();

    return arrayBuffer.slice(offset, offset + chunkSize);
  }
}

/**
 * Utility function to create ZIP from streaming downloads
 */
export async function createZipFromDownloads(
  downloads: Array<{ download: StreamingDownload; path: string }>,
  options: Partial<ChunkedZipOptions> = {}
): Promise<Blob> {
  const processor = new ChunkedZipProcessor(options);

  // Add all downloads to ZIP
  for (const { download, path } of downloads) {
    await processor.addStreamingDownload(download, path);
  }

  return processor.generateZip();
}

/**
 * Utility function to create ZIP from mixed content
 */
export async function createZipFromContent(
  entries: ZipEntry[],
  downloads: Array<{ download: StreamingDownload; path: string }>,
  options: Partial<ChunkedZipOptions> = {}
): Promise<Blob> {
  const processor = new ChunkedZipProcessor(options);

  // Add regular entries first
  await processor.addEntries(entries);

  // Add streaming downloads
  for (const { download, path } of downloads) {
    await processor.addStreamingDownload(download, path);
  }

  return processor.generateZip();
}

/**
 * Memory-efficient ZIP creation for large content
 */
export class MemoryEfficientZipCreator {
  private processor: ChunkedZipProcessor;
  private maxMemoryUsage: number;

  constructor(maxMemoryUsage: number = 100 * 1024 * 1024) { // 100MB default
    this.maxMemoryUsage = maxMemoryUsage;
    this.processor = new ChunkedZipProcessor({
      progressive: true,
      maxMemoryUsage,
      enableStreaming: true,
    });
  }

  async addFile(path: string, data: Blob | ArrayBuffer): Promise<void> {
    await this.checkMemoryUsage();

    await this.processor.addEntry({
      path,
      data,
      compress: true,
    });
  }

  async addDownload(path: string, download: StreamingDownload): Promise<void> {
    await this.checkMemoryUsage();
    await this.processor.addStreamingDownload(download, path);
  }

  async finalize(): Promise<Blob> {
    return this.processor.generateZip();
  }

  async finalizeStream(): Promise<ReadableStream> {
    return this.processor.generateZipStream();
  }

  getProgress(): ZipCreationProgress {
    return this.processor.getProgress();
  }

  private async checkMemoryUsage(): Promise<void> {
    const currentUsage = memoryManager.getMemoryStats().totalMemoryUsed;

    if (currentUsage > this.maxMemoryUsage * 0.8) {
      console.warn('High memory usage detected, performing cleanup');
      await memoryManager.forceCleanup();

      // Check again after cleanup
      const newUsage = memoryManager.getMemoryStats().totalMemoryUsed;
      if (newUsage > this.maxMemoryUsage * 0.9) {
        throw new Error('Insufficient memory to continue ZIP creation');
      }
    }
  }
}
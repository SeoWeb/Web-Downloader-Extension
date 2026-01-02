/**
 * Streaming URL Fetch Utilities
 * Provides streaming fetch capabilities with range requests and error handling
 */

import {
  MemoryPressureInfo,
} from '../types/streaming';
import { memoryManager } from './MemoryManager';

export interface StreamingFetchOptions {
  /** Size of chunks for streaming */
  chunkSize?: number;
  /** Maximum number of parallel chunks */
  maxParallelChunks?: number;
  /** Timeout for each chunk request */
  chunkTimeout?: number;
  /** Maximum number of retries */
  maxRetries?: number;
  /** Enable range requests */
  enableRangeRequests?: boolean;
  /** User agent to use */
  userAgent?: string;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Progress callback */
  onProgress?: (bytesReceived: number, totalBytes: number) => void;
  /** Memory pressure callback */
  onMemoryPressure?: (pressure: MemoryPressureInfo) => void;
}

export interface StreamingFetchResponse {
  /** Response URL */
  url: string;
  /** Content type */
  contentType: string | null;
  /** Content length */
  contentLength: number | null;
  /** Last modified */
  lastModified: string | null;
  /** ETag */
  etag: string | null;
  /** Whether server supports range requests */
  supportsRangeRequests: boolean;
  /** Readable stream for content */
  body?: ReadableStream<Uint8Array>;
  /** Create a chunk iterator */
  createChunkIterator: (chunkSize?: number) => AsyncGenerator<ArrayBuffer, void, unknown>;
  /** Get file metadata without downloading */
  getMetadata: () => Promise<FileMetadata>;
}

export interface FileMetadata {
  size: number;
  contentType: string | null;
  lastModified: string | null;
  etag: string | null;
  supportsRangeRequests: boolean;
  filename?: string;
}

export interface ChunkedDownloadResult {
  /** All downloaded chunks */
  chunks: ArrayBuffer[];
  /** Total size */
  totalSize: number;
  /** Metadata */
  metadata: FileMetadata;
}

/**
 * Enhanced fetch with streaming capabilities
 */
export class StreamingFetcher {
  private defaultOptions: StreamingFetchOptions;
  private activeRequests = new Map<string, AbortController>();

  constructor(options: Partial<StreamingFetchOptions> = {}) {
    this.defaultOptions = {
      chunkSize: 1024 * 1024, // 1MB
      maxParallelChunks: 3,
      chunkTimeout: 30000,
      maxRetries: 3,
      enableRangeRequests: true,
      userAgent: navigator.userAgent,
      ...options,
    };
  }

  /**
   * Fetch URL with streaming support
   */
  async fetchStreaming(
    url: string,
    options: Partial<StreamingFetchOptions> = {}
  ): Promise<StreamingFetchResponse> {
    const fetchOptions = { ...this.defaultOptions, ...options };
    const requestId = this.generateRequestId(url);

    try {
      // First, get file metadata with HEAD request
      const metadata = await this.getMetadata(url, fetchOptions);

      // Check if we should use streaming
      const useStreaming = this.shouldUseStreaming(metadata.size, fetchOptions);

      if (useStreaming && fetchOptions.enableRangeRequests && metadata.supportsRangeRequests) {
        return this.createStreamingResponse(url, metadata, fetchOptions, requestId);
      } else {
        return this.createRegularResponse(url, metadata, fetchOptions, requestId);
      }
    } catch (error) {
      this.cleanupRequest(requestId);
      throw error;
    }
  }

  /**
   * Download file in chunks
   */
  async downloadChunked(
    url: string,
    options: Partial<StreamingFetchOptions> = {}
  ): Promise<ChunkedDownloadResult> {
    const response = await this.fetchStreaming(url, options);
    const metadata = await response.getMetadata();
    const chunks: ArrayBuffer[] = [];
    let totalSize = 0;

    // Create chunk iterator
    const chunkSize = options.chunkSize || this.defaultOptions.chunkSize!;
    const chunkIterator = response.createChunkIterator(chunkSize);

    for await (const chunk of chunkIterator) {
      chunks.push(chunk);
      totalSize += chunk.byteLength;

      // Call progress callback
      if (options.onProgress) {
        options.onProgress(totalSize, metadata.size || 0);
      }

      // Check memory pressure
      if (options.onMemoryPressure) {
        const pressure = this.getMemoryPressure();
        if (pressure.level !== 'low') {
          options.onMemoryPressure(pressure);
        }
      }
    }

    return {
      chunks,
      totalSize,
      metadata,
    };
  }

  /**
   * Get file metadata without downloading content
   */
  async getMetadata(
    url: string,
    options: Partial<StreamingFetchOptions> = {}
  ): Promise<FileMetadata> {
    const fetchOptions = { ...this.defaultOptions, ...options };
    const controller = new AbortController();

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': fetchOptions.userAgent!,
          ...fetchOptions.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = response.headers.get('Content-Length');
      const lastModified = response.headers.get('Last-Modified');
      const etag = response.headers.get('ETag');
      const contentType = response.headers.get('Content-Type');
      const acceptRanges = response.headers.get('Accept-Ranges');
      const contentDisposition = response.headers.get('Content-Disposition');

      let filename: string | undefined;
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

      return {
        size: contentLength ? parseInt(contentLength) : 0,
        contentType,
        lastModified,
        etag,
        supportsRangeRequests: acceptRanges === 'bytes',
        filename,
      };
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  /**
   * Create streaming response with range request support
   */
  private async createStreamingResponse(
    url: string,
    metadata: FileMetadata,
    options: StreamingFetchOptions,
    requestId: string
  ): Promise<StreamingFetchResponse> {
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    const createChunkIterator = async function* (
      chunkSize: number = options.chunkSize!
    ): AsyncGenerator<ArrayBuffer, void, unknown> {
      if (metadata.size === 0) {
        return;
      }

      let offset = 0;
      const maxRetries = options.maxRetries!;

      while (offset < metadata.size) {
        const end = Math.min(offset + chunkSize - 1, metadata.size - 1);
        let retries = 0;
        let chunk: ArrayBuffer | null = null;

        while (retries <= maxRetries && !chunk) {
          try {
            const response = await fetch(url, {
              headers: {
                'Range': `bytes=${offset}-${end}`,
                'User-Agent': options.userAgent!,
                ...options.headers,
              },
              signal: controller.signal,
            });

            if (response.ok && response.status === 206) {
              chunk = await response.arrayBuffer();
            } else if (response.ok && response.status === 200) {
              // Server doesn't support range requests, fall back to full download
              const fullResponse = await response.arrayBuffer();
              chunk = fullResponse.slice(offset, end + 1);
            } else {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
          } catch (error) {
            retries++;
            if (retries <= maxRetries) {
              // Exponential backoff
              const delay = Math.min(1000 * Math.pow(2, retries), 10000);
              await new Promise(resolve => setTimeout(resolve, delay));
            } else {
              throw error;
            }
          }
        }

        if (!chunk) {
          throw new Error(`Failed to download chunk at offset ${offset}`);
        }

        yield chunk;
        offset = end + 1;
      }
    };

    // Create a readable stream
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const chunkIterator = createChunkIterator(options.chunkSize);
          for await (const chunk of chunkIterator) {
            controller.enqueue(new Uint8Array(chunk));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },

      cancel() {
        controller.abort();
      },
    });

    return {
      url,
      contentType: metadata.contentType,
      contentLength: metadata.size,
      lastModified: metadata.lastModified,
      etag: metadata.etag,
      supportsRangeRequests: metadata.supportsRangeRequests,
      body,
      createChunkIterator,
      getMetadata: async () => metadata,
    };
  }

  /**
   * Create regular response without streaming
   */
  private async createRegularResponse(
    url: string,
    metadata: FileMetadata,
    options: StreamingFetchOptions,
    requestId: string
  ): Promise<StreamingFetchResponse> {
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);

    const createChunkIterator = async function* (
      chunkSize: number = options.chunkSize!
    ): AsyncGenerator<ArrayBuffer, void, unknown> {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': options.userAgent!,
          ...options.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const buffer = new Uint8Array(chunkSize);
      let offset = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (offset + value.length > buffer.length) {
            // Yield current buffer and create new one
            if (offset > 0) {
              yield buffer.slice(0, offset).buffer;
              offset = 0;
            }
            // Create a new buffer for the remaining data
            const newBuffer = new Uint8Array(Math.max(chunkSize, value.length));
            newBuffer.set(value, offset);
            buffer.set(newBuffer, 0);
          } else {
            buffer.set(value, offset);
            offset += value.length;
          }
        }

        // Yield remaining data
        if (offset > 0) {
          yield buffer.slice(0, offset).buffer;
        }
      } finally {
        reader.releaseLock();
      }
    };

    return {
      url,
      contentType: metadata.contentType,
      contentLength: metadata.size,
      lastModified: metadata.lastModified,
      etag: metadata.etag,
      supportsRangeRequests: false,
      body: undefined, // Don't create body for non-streaming
      createChunkIterator,
      getMetadata: async () => metadata,
    };
  }

  /**
   * Determine if streaming should be used
   */
  private shouldUseStreaming(fileSize: number, options: StreamingFetchOptions): boolean {
    const streamingThreshold = 10 * 1024 * 1024; // 10MB

    // Always stream for large files
    if (fileSize > streamingThreshold) {
      return true;
    }

    // Use streaming for unknown file sizes
    if (fileSize === 0) {
      return true;
    }

    // Use streaming if explicitly requested
    return options.enableRangeRequests || false;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(url: string): string {
    const hash = this.simpleHash(url);
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `fetch-${hash}-${timestamp}-${random}`;
  }

  /**
   * Simple hash function for URLs
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) & 0xffffffff;
    }
    return Math.abs(hash).toString(36);
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
    if (percentageUsed >= 0.95) {
      level = 'critical';
    } else if (percentageUsed >= 0.85) {
      level = 'high';
    } else if (percentageUsed >= 0.75) {
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
   * Clean up request
   */
  private cleanupRequest(requestId: string): void {
    this.activeRequests.delete(requestId);
  }
}
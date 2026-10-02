/**
 * Streaming Download Types and Interfaces
 * Provides comprehensive type definitions for streaming downloads and chunked processing
 */

export interface ChunkInfo {
  /** Chunk index in the sequence */
  index: number;
  /** Starting byte position of the chunk */
  start: number;
  /** Ending byte position of the chunk */
  end: number;
  /** Size of the chunk in bytes */
  size: number;
  /** Download completion status */
  downloaded: boolean;
  /** Number of retry attempts */
  retryCount: number;
  /** Timestamp when chunk was downloaded */
  downloadedAt?: number;
  /** Chunk data URL or blob reference */
  data?: string | Blob;
  /** Checksum for data integrity */
  checksum?: string;
}

export interface StreamingDownload {
  /** Unique identifier for the download */
  id: string;
  /** URL being downloaded */
  url: string;
  /** Total file size in bytes (0 if unknown) */
  totalSize: number;
  /** Currently downloaded bytes */
  downloadedSize: number;
  /** Download progress (0-1) */
  progress: number;
  /** All chunks for this download */
  chunks: ChunkInfo[];
  /** Current download status */
  status: StreamingDownloadStatus;
  /** When the download was started */
  startedAt: number;
  /** When the download was last updated */
  updatedAt: number;
  /** When the download was completed */
  completedAt?: number;
  /** Error information if failed */
  error?: string;
  /** MIME type of the content */
  mimeType?: string;
  /** Suggested filename */
  filename?: string;
  /** Whether this download can be resumed */
  resumable: boolean;
  /** Number of parallel chunks being downloaded */
  activeChunks: number;
  /** Optimal chunk size for this download */
  chunkSize: number;
}

export type StreamingDownloadStatus =
  | "pending"
  | "starting"
  | "streaming"
  | "paused"
  | "completed"
  | "failed"
  | "aborted"
  | "resuming";

export interface StreamingOptions {
  /** Size of each chunk in bytes (default: 1MB) */
  chunkSize?: number;
  /** Maximum number of parallel chunk downloads (default: 3) */
  maxParallelChunks?: number;
  /** Maximum number of retry attempts per chunk (default: 3) */
  maxRetries?: number;
  /** Enable download resumption (default: true) */
  enableResumption?: boolean;
  /** Enable progress persistence (default: true) */
  enablePersistence?: boolean;
  /** Timeout for each chunk download in ms (default: 30000) */
  chunkTimeout?: number;
  /** Enable checksum verification (default: false) */
  enableChecksums?: boolean;
  /** Force streaming even for small files (default: false) */
  forceStreaming?: boolean;
  /** Minimum file size to trigger streaming (default: 5MB) */
  streamingThreshold?: number;
  /** Enable memory pressure monitoring (default: true) */
  monitorMemory?: boolean;
}

export interface StreamingProgress {
  /** Download ID */
  downloadId: string;
  /** Number of completed chunks */
  completedChunks: number;
  /** Total number of chunks */
  totalChunks: number;
  /** Bytes downloaded */
  bytesDownloaded: number;
  /** Total bytes to download */
  totalBytes: number;
  /** Download speed in bytes per second */
  downloadSpeed: number;
  /** Estimated time remaining in seconds */
  eta: number;
  /** Current status */
  status: StreamingDownloadStatus;
}

export interface ChunkedZipOptions {
  /** Enable progressive ZIP creation */
  progressive: boolean;
  /** Compression level (0-9) */
  compressionLevel?: number;
  /** Maximum memory usage for ZIP creation */
  maxMemoryUsage?: number;
  /** Enable ZIP streaming to disk */
  enableStreaming?: boolean;
  /** Chunk size for ZIP streaming */
  zipChunkSize?: number;
}

export interface ProgressPersistence {
  /** Save download progress to storage */
  saveProgress(download: StreamingDownload): Promise<void>;
  /** Load download progress from storage */
  loadProgress(downloadId: string): Promise<StreamingDownload | null>;
  /** Remove download progress from storage */
  removeProgress(downloadId: string): Promise<void>;
  /** List all persisted downloads */
  listPersistedDownloads(): Promise<string[]>;
  /** Cleanup old downloads */
  cleanup(olderThan?: number): Promise<void>;
}

export interface MemoryPressureInfo {
  /** Current memory usage level */
  level: "low" | "medium" | "high" | "critical";
  /** Total memory used in bytes */
  bytesUsed: number;
  /** Memory limit in bytes */
  bytesLimit: number;
  /** Percentage of memory used */
  percentageUsed: number;
  /** Whether to pause downloads */
  shouldPause: boolean;
  /** Whether to reduce parallelism */
  shouldReduceParallelism: boolean;
}

export interface StreamingEventListeners {
  /** Called when download starts */
  onStart?: (download: StreamingDownload) => void;
  /** Called when a chunk is downloaded */
  onChunkProgress?: (download: StreamingDownload, chunk: ChunkInfo) => void;
  /** Called when overall progress updates */
  onProgress?: (progress: StreamingProgress) => void;
  /** Called when download completes */
  onComplete?: (download: StreamingDownload) => void;
  /** Called when download fails */
  onError?: (download: StreamingDownload, error: Error) => void;
  /** Called when download is paused */
  onPause?: (download: StreamingDownload) => void;
  /** Called when download is resumed */
  onResume?: (download: StreamingDownload) => void;
  /** Called when memory pressure changes */
  onMemoryPressure?: (pressure: MemoryPressureInfo) => void;
}

export interface StreamProcessor {
  /** Process a chunk of data */
  processChunk(
    chunk: ArrayBuffer,
    context: ProcessingContext,
  ): Promise<ArrayBuffer>;
  /** Get processor metadata */
  getMetadata(): ProcessorMetadata;
}

export interface ProcessingContext {
  /** Download ID */
  downloadId: string;
  /** Chunk index */
  chunkIndex: number;
  /** Total chunks */
  totalChunks: number;
  /** MIME type of the content */
  mimeType?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

export interface ProcessorMetadata {
  /** Processor name */
  name: string;
  /** Supported MIME types */
  supportedMimeTypes: string[];
  /** Whether processor can handle streaming */
  supportsStreaming: boolean;
  /** Maximum chunk size supported */
  maxChunkSize: number;
}

export interface StreamingDownloaderConfig {
  /** Default options for all downloads */
  defaultOptions: StreamingOptions;
  /** Global maximum concurrent downloads */
  maxConcurrentDownloads?: number;
  /** Global maximum concurrent chunks */
  maxConcurrentChunks?: number;
  /** Memory management settings */
  memorySettings: {
    /** Maximum memory usage for streaming */
    maxMemoryUsage: number;
    /** Memory cleanup threshold */
    cleanupThreshold: number;
    /** Garbage collection interval */
    gcInterval: number;
  };
  /** Storage settings */
  storageSettings: {
    /** Maximum age for persisted progress */
    maxProgressAge: number;
    /** Maximum number of persisted downloads */
    maxPersistedDownloads: number;
    /** Cleanup interval */
    cleanupInterval: number;
  };
}

// Default constants
export const DEFAULT_STREAMING_OPTIONS: StreamingOptions = {
  chunkSize: 1024 * 1024, // 1MB
  maxParallelChunks: 3,
  maxRetries: 3,
  enableResumption: true,
  enablePersistence: true,
  chunkTimeout: 30000,
  enableChecksums: false,
  forceStreaming: false,
  streamingThreshold: 5 * 1024 * 1024, // 5MB
  monitorMemory: true,
};

export const DEFAULT_CHUNKED_ZIP_OPTIONS: ChunkedZipOptions = {
  progressive: true,
  compressionLevel: 6,
  maxMemoryUsage: 50 * 1024 * 1024, // 50MB
  enableStreaming: true,
  zipChunkSize: 1024 * 1024, // 1MB
};

export const MEMORY_THRESHOLDS = {
  LOW: 0.6, // 60%
  MEDIUM: 0.75, // 75%
  HIGH: 0.85, // 85%
  CRITICAL: 0.95, // 95%
} as const;

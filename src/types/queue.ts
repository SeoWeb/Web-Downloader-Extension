/**
 * Request Queue Types and Interfaces
 * Provides comprehensive type definitions for intelligent request throttling and queue management
 */

export enum RequestPriority {
  CRITICAL = 1, // HTML, critical CSS
  HIGH = 2, // JS, fonts
  NORMAL = 3, // Images, documents
  LOW = 4, // Optional resources
}

export enum ResourceType {
  HTML = "HTML",
  CSS = "CSS",
  JS = "JS",
  IMAGE = "IMAGE",
  FONT = "FONT",
  DOCUMENT = "DOCUMENT",
  VIDEO = "VIDEO",
  AUDIO = "AUDIO",
  OTHER = "OTHER",
}

export enum RequestStatus {
  QUEUED = "queued",
  PENDING = "pending",
  DOWNLOADING = "downloading",
  COMPLETED = "completed",
  FAILED = "failed",
  RETRYING = "retrying",
  CANCELLED = "cancelled",
}

export interface QueuedRequest {
  /** Unique identifier for the request */
  id: string;
  /** URL to fetch */
  url: string;
  /** Priority level for scheduling */
  priority: RequestPriority;
  /** Type of resource being requested */
  resourceType: ResourceType;
  /** Domain of the request for rate limiting */
  domain: string;
  /** List of dependency request IDs */
  dependencies: string[];
  /** Current retry count */
  retryCount: number;
  /** Estimated size in bytes */
  estimatedSize: number;
  /** Current status of the request */
  status: RequestStatus;
  /** When the request was queued */
  queuedAt: number;
  /** When the request was started */
  startedAt?: number;
  /** When the request was completed */
  completedAt?: number;
  /** Error information if failed */
  error?: string;
  /** Download ID for tracking */
  downloadId?: string;
  /** Base URL for resolving relative URLs */
  baseUrl?: string;
  /** Additional fetch options */
  fetchOptions?: any;
  /** Progress callback */
  onProgress?: (progress: RequestProgress) => void;
  /** Completion callback */
  onComplete?: (result: RequestResult) => void;
  /** Error callback */
  onError?: (error: Error) => void;
}

export interface ActiveRequest {
  /** Request information */
  request: QueuedRequest;
  /** Abort controller for cancellation */
  controller: AbortController;
  /** Start timestamp */
  startTime: number;
  /** Current progress */
  progress: RequestProgress;
}

export interface RequestProgress {
  /** Request ID */
  requestId: string;
  /** Bytes downloaded */
  bytesDownloaded: number;
  /** Total bytes to download */
  totalBytes: number;
  /** Progress percentage (0-1) */
  progress: number;
  /** Download speed in bytes per second */
  downloadSpeed: number;
  /** Estimated time remaining in seconds */
  eta: number;
}

export interface RequestResult {
  /** Request ID */
  requestId: string;
  /** URL that was fetched */
  url: string;
  /** Response data */
  response: Response;
  /** Download duration in milliseconds */
  duration: number;
  /** Final size in bytes */
  size: number;
  /** Whether the response was from cache */
  fromCache: boolean;
}

export interface DomainLimiter {
  /** Domain name */
  domain: string;
  /** Maximum requests per second */
  maxRequestsPerSecond: number;
  /** Current active requests */
  activeRequests: number;
  /** Request timestamps for rate limiting */
  requestTimestamps: number[];
  /** Last request timestamp */
  lastRequestTime: number;
  /** Whether to respect robots.txt crawl delay */
  respectRobotsTxt: boolean;
  /** Crawl delay from robots.txt in milliseconds */
  crawlDelay: number;
  /** Connection pool size */
  connectionPoolSize: number;
  /** Current connection usage */
  activeConnections: number;
}

export interface QueueStats {
  /** Total number of queued requests */
  totalQueued: number;
  /** Number of active requests */
  activeRequests: number;
  /** Number of completed requests */
  completedRequests: number;
  /** Number of failed requests */
  failedRequests: number;
  /** Average request duration in milliseconds */
  averageRequestDuration: number;
  /** Current throughput in requests per second */
  currentThroughput: number;
  /** Memory usage in bytes */
  memoryUsage: number;
  /** Queue processing rate */
  processingRate: number;
}

export interface ThrottlingConfig {
  /** Maximum concurrent requests */
  maxConcurrentRequests: number;
  /** Default requests per second per domain */
  defaultDomainRateLimit: number;
  /** Adaptive throttling enabled */
  enableAdaptiveThrottling: boolean;
  /** Memory pressure threshold for reducing concurrency */
  memoryPressureThreshold: number;
  /** Network condition monitoring enabled */
  enableNetworkMonitoring: boolean;
  /** Request timeout in milliseconds */
  requestTimeout: number;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Exponential backoff base */
  backoffBase: number;
  /** Maximum backoff delay in milliseconds */
  maxBackoffDelay: number;
  /** Enable request deduplication */
  enableDeduplication: boolean;
  /** Cache TTL for deduplication in milliseconds */
  deduplicationCacheTtl: number;
}

export interface NetworkCondition {
  /** Current network quality */
  quality: "slow" | "fast" | "unknown";
  /** Estimated bandwidth in bytes per second */
  bandwidth: number;
  /** Current latency in milliseconds */
  latency: number;
  /** Whether network is currently congested */
  congested: boolean;
  /** Last measurement timestamp */
  measuredAt: number;
}

export interface QueueEventListeners {
  /** Called when a request is queued */
  onQueued?: (request: QueuedRequest) => void;
  /** Called when a request starts */
  onStart?: (request: QueuedRequest) => void;
  /** Called when request progress updates */
  onProgress?: (progress: RequestProgress) => void;
  /** Called when a request completes */
  onComplete?: (result: RequestResult) => void;
  /** Called when a request fails */
  onError?: (request: QueuedRequest, error: Error) => void;
  /** Called when a request is retried */
  onRetry?: (request: QueuedRequest, attempt: number) => void;
  /** Called when queue is empty */
  onEmpty?: () => void;
  /** Called when memory pressure changes */
  onMemoryPressure?: (level: "low" | "medium" | "high" | "critical") => void;
  /** Called when network conditions change */
  onNetworkChange?: (condition: NetworkCondition) => void;
}

export interface RequestQueueOptions {
  /** Throttling configuration */
  throttling?: Partial<ThrottlingConfig>;
  /** Event listeners */
  eventListeners?: QueueEventListeners;
  /** Custom priority resolver */
  priorityResolver?: (url: string, type: ResourceType) => RequestPriority;
  /** Custom domain rate limits */
  domainRateLimits?: Map<string, number>;
  /** Enable request deduplication */
  enableDeduplication?: boolean;
  /** Enable dependency resolution */
  enableDependencies?: boolean;
}

// Default configurations
export const DEFAULT_THROTTLING_CONFIG: ThrottlingConfig = {
  maxConcurrentRequests: 25,
  defaultDomainRateLimit: 8,
  enableAdaptiveThrottling: true,
  memoryPressureThreshold: 0.8,
  enableNetworkMonitoring: true,
  requestTimeout: 30000,
  maxRetries: 3,
  backoffBase: 1000,
  maxBackoffDelay: 10000,
  enableDeduplication: true,
  deduplicationCacheTtl: 60000, // 1 minute
};

export const DEFAULT_QUEUE_OPTIONS: RequestQueueOptions = {
  throttling: DEFAULT_THROTTLING_CONFIG,
  enableDeduplication: true,
  enableDependencies: true,
};

// Utility functions
export function getResourceTypeFromUrl(url: string): ResourceType {
  const extension = url.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "html":
    case "htm":
    case "xhtml":
      return ResourceType.HTML;

    case "css":
      return ResourceType.CSS;

    case "js":
    case "mjs":
    case "jsx":
    case "ts":
    case "tsx":
      return ResourceType.JS;

    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
    case "bmp":
    case "ico":
      return ResourceType.IMAGE;

    case "woff":
    case "woff2":
    case "ttf":
    case "otf":
    case "eot":
      return ResourceType.FONT;

    case "pdf":
    case "doc":
    case "docx":
    case "xls":
    case "xlsx":
    case "ppt":
    case "pptx":
      return ResourceType.DOCUMENT;

    case "mp4":
    case "webm":
    case "avi":
    case "mov":
    case "mkv":
      return ResourceType.VIDEO;

    case "mp3":
    case "wav":
    case "ogg":
    case "flac":
    case "aac":
      return ResourceType.AUDIO;

    default:
      return ResourceType.OTHER;
  }
}

export function getPriorityForResourceType(
  type: ResourceType,
): RequestPriority {
  switch (type) {
    case ResourceType.HTML:
      return RequestPriority.CRITICAL;

    case ResourceType.CSS:
    case ResourceType.JS:
    case ResourceType.FONT:
      return RequestPriority.HIGH;

    case ResourceType.IMAGE:
    case ResourceType.DOCUMENT:
      return RequestPriority.NORMAL;

    case ResourceType.VIDEO:
    case ResourceType.AUDIO:
    case ResourceType.OTHER:
      return RequestPriority.LOW;

    default:
      return RequestPriority.NORMAL;
  }
}

export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return "unknown";
  }
}

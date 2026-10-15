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

/**
 * Fetch response type as reported by the Fetch spec.
 * "opaque" responses (no-cors) have an unreadable body — consumers must
 * branch on this flag instead of calling bytes()/text().
 */
export type ResponseSnapshotType =
  | "basic"
  | "cors"
  | "default"
  | "opaque"
  | "error";

/**
 * Immutable snapshot of a fetched response. Stored by the dedup cache and
 * used to hand every consumer an independently readable result, instead of
 * sharing a single `Response` whose body can only be consumed once.
 */
export interface ResponseSnapshot {
  ok: boolean;
  status: number;
  statusText: string;
  /** Lowercased header name -> value */
  headers: Record<string, string>;
  contentType: string;
  /** Response type info — "opaque" means the body could not be read (no-cors). */
  type: ResponseSnapshotType;
  /** Raw response bytes. `null` for opaque responses (body is unreadable). */
  bytes: Uint8Array | null;
  /** Decoded text when the queue chose the text form; usually `null`. */
  text: string | null;
}

export interface RequestResult {
  /** Request ID */
  requestId: string;
  /** URL that was fetched */
  url: string;
  /**
   * Response data. A fresh, independently readable `Response` reconstructed
   * from the snapshot on every access — each consumer may read the body.
   */
  readonly response: Response;
  /** Immutable snapshot backing `response`; bytes/text can be read directly. */
  readonly snapshot: ResponseSnapshot;
  /** Response type info — "opaque" bodies are unreadable (no-cors). */
  readonly type: ResponseSnapshotType;
  /** Download duration in milliseconds */
  duration: number;
  /** Final size in bytes */
  size: number;
  /** Whether the response was from cache */
  fromCache: boolean;
}

/** Error categories used to classify queue request failures. */
export type RequestErrorCategory =
  | "timeout"
  | "cancelled"
  | "network"
  | "http"
  | "unknown";

/** Error thrown/recorded by the request queue with a machine-readable category. */
export class RequestQueueError extends Error {
  readonly category: RequestErrorCategory;
  /** HTTP status for "http" category errors. */
  readonly status?: number;
  /** Retry-After hint from the server, in milliseconds (when provided). */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    category: RequestErrorCategory = "unknown",
    options?: { status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "RequestQueueError";
    this.category = category;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Response bodies above this size are not stored in the dedup cache (re-fetched instead). */
export const MAX_DEDUP_CACHE_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

/** Build an immutable snapshot from a fetched response and its read-once bytes. */
export function createResponseSnapshot(
  response: Response,
  bytes: Uint8Array | null,
): ResponseSnapshot {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers,
    contentType: headers["content-type"] ?? "",
    type: (response.type as ResponseSnapshotType) || "default",
    bytes,
    text: null,
  };
}

/**
 * Reconstruct a fresh, independently readable Response from a snapshot.
 * Each call returns a new Response backed by the snapshot bytes, so several
 * consumers can read the body without "body has already been consumed".
 */
export function snapshotToResponse(snapshot: ResponseSnapshot): Response {
  if (snapshot.type === "opaque") {
    // Status 0 responses cannot be constructed — hand back an empty body.
    // Consumers must branch on snapshot.type instead of reading the body.
    return new Response(null, { headers: snapshot.headers });
  }

  const status =
    snapshot.status >= 200 && snapshot.status <= 599 ? snapshot.status : 200;
  // Null-body statuses reject a non-null body in the Response constructor.
  const isNullBodyStatus =
    snapshot.status === 204 ||
    snapshot.status === 205 ||
    snapshot.status === 304;
  const body =
    snapshot.bytes && !isNullBodyStatus ? new Uint8Array(snapshot.bytes) : null;

  return new Response(body, {
    status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

/** Decode snapshot bytes as text (UTF-8 unless a consumer handles charset). */
export async function snapshotText(
  snapshot: ResponseSnapshot,
): Promise<string> {
  if (snapshot.text !== null) {
    return snapshot.text;
  }
  if (!snapshot.bytes) {
    return "";
  }
  return new TextDecoder().decode(snapshot.bytes);
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

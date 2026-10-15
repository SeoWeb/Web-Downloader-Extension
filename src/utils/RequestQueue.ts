/**
 * Request Queue
 * Main queue implementation that coordinates scheduling, throttling, and domain limiting
 */

import {
  QueuedRequest,
  ActiveRequest,
  RequestStatus,
  ResourceType,
  RequestResult,
  RequestErrorCategory,
  RequestQueueError,
  ResponseSnapshot,
  QueueEventListeners,
  RequestQueueOptions,
  DEFAULT_QUEUE_OPTIONS,
  DEFAULT_THROTTLING_CONFIG,
  createResponseSnapshot,
  snapshotToResponse,
  extractDomain,
  getResourceTypeFromUrl,
  getPriorityForResourceType,
} from "../types/queue";
import { RequestScheduler } from "./RequestScheduler";
import { DomainLimiterFactory } from "./DomainLimiter";
import { ThrottlingManager } from "./ThrottlingManager";
import { memoryManager } from "./MemoryManager";

/** Default tick between processing cycles (only used when work is possible). */
const QUEUE_TICK_MS = 10;
/** Upper bound for a single limiter-availability wait (re-evaluate periodically). */
const MAX_SCHEDULE_DELAY_MS = 30_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Composite abort handle: the download's own signal OR the per-request timeout. */
interface CompositeAbort {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * Build a composite abort that fires when either the external signal aborts
 * (with the caller's reason) or the timeout elapses (with a TimeoutError
 * reason), so `requestTimeout` is actually enforced on every fetch.
 */
function createCompositeAbort(
  external: AbortSignal,
  timeoutMs: number,
): CompositeAbort {
  const composite = new AbortController();

  const timer = setTimeout(() => {
    composite.abort(
      new DOMException(
        `Request timed out after ${timeoutMs}ms`,
        "TimeoutError",
      ),
    );
  }, timeoutMs);

  const onExternalAbort = () => {
    clearTimeout(timer);
    const reason =
      external.reason ??
      new DOMException("The request was aborted", "AbortError");
    composite.abort(reason);
  };

  if (external.aborted) {
    onExternalAbort();
  } else {
    external.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    signal: composite.signal,
    cleanup() {
      clearTimeout(timer);
      external.removeEventListener("abort", onExternalAbort);
    },
  };
}

/** Classify an abort rejection as a queue error category, or null if not an abort. */
function classifyAbort(
  error: unknown,
  external: AbortSignal,
  timeoutMs: number,
): RequestQueueError | null {
  if (external.aborted) {
    return new RequestQueueError("Request cancelled", "cancelled");
  }
  if ((error as { name?: string })?.name === "TimeoutError") {
    return new RequestQueueError(
      `Request timed out after ${timeoutMs}ms`,
      "timeout",
    );
  }
  return null;
}

/** Wrap an unknown failure as a categorized queue error. */
function toRequestQueueError(
  error: unknown,
  category: RequestErrorCategory,
): RequestQueueError {
  if (error instanceof RequestQueueError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RequestQueueError(message || "Network request failed", category, {
    cause: error,
  });
}

/** Parse a Retry-After header (seconds or HTTP-date) into milliseconds. */
function parseRetryAfterHeader(headers: Headers): number | undefined {
  const value = headers.get("Retry-After");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

export class RequestQueue {
  private options: RequestQueueOptions;
  private scheduler: RequestScheduler;
  private throttlingManager: ThrottlingManager;
  private activeRequests: Map<string, ActiveRequest> = new Map();
  private isProcessing: boolean = false;
  private processingTimer: NodeJS.Timeout | null = null;
  private nextProcessingAt: number = 0;
  /** Suppresses prompt re-scheduling while deferred requests are re-queued. */
  private isRequeueingDeferred: boolean = false;
  private requestCounter: number = 0;
  /**
   * Pending detached retries (requestId → timer + request). Tracked so a
   * scoped (`clearDownload`) or full (`clear`) teardown can cancel retry
   * bookkeeping that would otherwise re-enqueue a request after its download
   * has finished — an orphan fetch whose result is never uploaded.
   */
  private retryTimers: Map<
    string,
    { timer: NodeJS.Timeout; request: QueuedRequest }
  > = new Map();

  constructor(options?: Partial<RequestQueueOptions>) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };

    // Initialize components. The scheduler receives the wrapped listeners
    // below (setupEventListeners integrates queue-level caching, retries and
    // scheduling) — passing the raw user listeners here would silently bypass
    // that integration for instances configured via the constructor.
    this.scheduler = new RequestScheduler();
    this.throttlingManager = new ThrottlingManager(this.options.throttling);

    // Set up event listeners
    this.setupEventListeners();
    this.scheduler.setEventListeners(this.options.eventListeners ?? {});

    // Start processing
    this.startProcessing();
  }

  /**
   * Add a request to the queue
   */
  public async enqueue(
    request: Omit<QueuedRequest, "id" | "status" | "queuedAt">,
  ): Promise<string> {
    // Generate unique ID
    const id = this.generateRequestId();

    // Extract domain
    const domain = extractDomain(request.url);

    // Determine resource type if not provided
    const resourceType =
      request.resourceType || getResourceTypeFromUrl(request.url);

    // Determine priority if not provided
    const priority =
      request.priority || getPriorityForResourceType(resourceType);

    // Check for duplicates — the cached result is a snapshot-backed
    // RequestResult whose response is independently readable per consumer.
    if (this.throttlingManager.isDuplicateRequest(request.url)) {
      const cachedResult = this.throttlingManager.getCachedResult(request.url);
      if (cachedResult && request.onComplete) {
        request.onComplete(cachedResult);
      }
      return id;
    }

    // Create full request object
    const fullRequest: QueuedRequest = {
      ...request,
      id,
      status: RequestStatus.QUEUED,
      queuedAt: Date.now(),
      priority,
      resourceType,
      domain,
      retryCount: request.retryCount || 0,
      estimatedSize: request.estimatedSize || 0,
    };

    // Add to scheduler
    this.scheduler.enqueue(fullRequest);

    return id;
  }

  /**
   * Get queue statistics
   */
  public getStats(): {
    queued: number;
    active: number;
    completed: number;
    failed: number;
    adaptiveConcurrency: number;
    memoryPressureLevel: string;
    networkQuality: string;
    processingRate: number;
  } {
    const schedulerStats = this.scheduler.getStats();
    const throttlingStats = this.throttlingManager.getStats();

    return {
      queued: schedulerStats.queued,
      active: schedulerStats.active,
      completed: schedulerStats.completed,
      failed: schedulerStats.failed,
      adaptiveConcurrency: throttlingStats.adaptiveConcurrency,
      memoryPressureLevel: throttlingStats.memoryPressureLevel,
      networkQuality: throttlingStats.networkQuality,
      processingRate: schedulerStats.processingRate,
    };
  }

  /**
   * Get all queued requests
   */
  public getQueuedRequests(): QueuedRequest[] {
    return this.scheduler.getQueuedRequests();
  }

  /**
   * Get all active requests
   */
  public getActiveRequests(): ActiveRequest[] {
    return Array.from(this.activeRequests.values());
  }

  /**
   * Cancel a request
   */
  public cancelRequest(requestId: string): boolean {
    // Abort in-flight requests first — the scheduler only does bookkeeping
    // for its own active map and would otherwise swallow the cancellation.
    // The rejection path releases the queue slot and memory, and reports a
    // categorized "cancelled" error.
    const activeRequest = this.activeRequests.get(requestId);
    if (activeRequest) {
      activeRequest.controller.abort();
      return true;
    }

    // Try to cancel in scheduler (still-queued requests)
    return this.scheduler.cancelRequest(requestId);
  }

  /**
   * Pause processing
   */
  public pause(): void {
    this.isProcessing = false;
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
      this.nextProcessingAt = 0;
    }
  }

  /**
   * Resume processing
   */
  public resume(): void {
    this.isProcessing = true;
    this.scheduleProcessing();
  }

  /**
   * Clear all requests (global teardown).
   *
   * ONLY safe when no other download is active — callers gate this on the
   * active-downloads tracking (see download-core's finally). It aborts every
   * in-flight request and drops every queued request of ALL downloads.
   */
  public clear(): void {
    // Cancel pending detached retries first — a cleared request must never
    // re-enqueue itself after teardown (orphan fetch).
    for (const entry of this.retryTimers.values()) {
      clearTimeout(entry.timer);
    }
    this.retryTimers.clear();

    // Cancel all active requests
    for (const activeRequest of this.activeRequests.values()) {
      activeRequest.controller.abort();
    }
    this.activeRequests.clear();

    // Clear scheduler; settle the dropped queued requests so awaiting
    // handlers resolve instead of hanging on a promise that never settles.
    const dropped = this.scheduler.clear();
    for (const request of dropped) {
      if (request.onError) {
        request.onError(
          new RequestQueueError("Request queue cleared", "cancelled"),
        );
      }
    }
  }

  /**
   * Scoped teardown for ONE download (concurrent-downloads spec / design D7).
   *
   * Purges ONLY the per-download state tagged with `downloadId`:
   *  - pending detached retry timers,
   *  - still-queued / deferred requests (their error callbacks settle),
   *  - in-flight requests (aborted so they settle via their own error path).
   *
   * Global concerns — domain limiters, throttling/congestion signals,
   * scheduler concurrency, and the URL-keyed dedup cache — are untouched, so
   * a finishing download can never destroy another active download's state.
   */
  public clearDownload(downloadId: string): void {
    if (!downloadId) {
      return;
    }

    // 1. Cancel this download's pending detached retries.
    for (const [requestId, entry] of this.retryTimers) {
      if (entry.request.downloadId === downloadId) {
        clearTimeout(entry.timer);
        this.retryTimers.delete(requestId);
      }
    }

    // 2. Abort this download's in-flight requests — each settles through the
    //    normal cancellation path (fetch rejects → failRequest → release).
    for (const activeRequest of this.activeRequests.values()) {
      if (activeRequest.request.downloadId === downloadId) {
        activeRequest.controller.abort();
      }
    }

    // 3. Purge this download's still-queued requests, settling their error
    //    callbacks so awaiting handlers resolve instead of hanging.
    const purged = this.scheduler.removeQueuedForDownload(downloadId);
    for (const request of purged) {
      if (request.onError) {
        request.onError(
          new RequestQueueError("Download finished", "cancelled"),
        );
      }
    }
  }

  /**
   * Shutdown the queue
   */
  public shutdown(): void {
    this.clear();
    this.pause();
    this.scheduler.shutdown();
    this.throttlingManager.shutdown();
  }

  /**
   * Get current event listeners
   */
  public getEventListeners(): QueueEventListeners | undefined {
    return this.options.eventListeners;
  }

  /**
   * Set event listeners
   */
  public setEventListeners(listeners: QueueEventListeners): void {
    this.options.eventListeners = listeners;
    // Re-wrap listeners to ensure queue integration
    this.setupEventListeners();
    // Update scheduler with wrapped listeners
    this.scheduler.setEventListeners(this.options.eventListeners);
    // Update throttling manager
    this.throttlingManager.setEventListeners(this.options.eventListeners);
  }

  /**
   * Update configuration
   */
  public updateConfig(options: Partial<RequestQueueOptions>): void {
    this.options = { ...this.options, ...options };

    if (options.throttling) {
      this.throttlingManager.updateConfig(options.throttling);
    }
  }

  /**
   * Set up event listeners
   */
  private setupEventListeners(): void {
    // Override scheduler event listeners to integrate with queue
    const originalListeners = this.options.eventListeners || {};

    const wrappedListeners: QueueEventListeners = {
      ...originalListeners,

      onQueued: (request) => {
        if (originalListeners.onQueued) {
          originalListeners.onQueued(request);
        }
        // Deferred re-queues schedule their own limiter-availability wait; a
        // prompt tick here would degenerate into the old 10ms busy-spin.
        if (!this.isRequeueingDeferred) {
          this.scheduleProcessing();
        }
      },

      onStart: (request) => {
        if (originalListeners.onStart) {
          originalListeners.onStart(request);
        }
      },

      onComplete: (result) => {
        // Cache successful results (large bodies are skipped by the manager)
        this.throttlingManager.cacheRequestResult(result.url, result);

        if (originalListeners.onComplete) {
          originalListeners.onComplete(result);
        }
      },

      onError: (request, error) => {
        // Handle retries - only retry transient errors, not permanent ones
        const maxRetries =
          this.options.throttling?.maxRetries ??
          DEFAULT_THROTTLING_CONFIG.maxRetries;
        const shouldRetry =
          request.retryCount < maxRetries && this.isRetryableError(error);

        if (shouldRetry) {
          this.retryRequest(request);
        } else {
          if (originalListeners.onError) {
            originalListeners.onError(request, error);
          }
        }
      },

      onEmpty: () => {
        if (originalListeners.onEmpty) {
          originalListeners.onEmpty();
        }
      },
    };

    this.options.eventListeners = wrappedListeners;
  }

  /**
   * Start processing loop
   */
  private startProcessing(): void {
    this.isProcessing = true;
    this.scheduleProcessing();
  }

  /**
   * Schedule the next processing cycle.
   *
   * Coalesced: the earliest requested run wins so completion ticks stay
   * prompt, while a long limiter-availability wait is not broken by a storm
   * of prompt ticks from deferred re-queues.
   */
  private scheduleProcessing(delayMs: number = QUEUE_TICK_MS): void {
    if (!this.isProcessing) {
      return;
    }

    const desiredAt = Date.now() + Math.max(0, delayMs);

    if (this.processingTimer) {
      if (this.nextProcessingAt <= desiredAt) {
        return; // An earlier (or equal) run is already scheduled
      }
      clearTimeout(this.processingTimer);
    }

    this.nextProcessingAt = desiredAt;
    this.processingTimer = setTimeout(
      () => {
        this.processingTimer = null;
        this.processQueue();
      },
      Math.max(0, desiredAt - Date.now()),
    );
  }

  /**
   * Re-queue deferred requests without triggering prompt processing ticks.
   */
  private requeueDeferred(requests: QueuedRequest[]): void {
    if (requests.length === 0) {
      return;
    }
    this.isRequeueingDeferred = true;
    try {
      for (const request of requests) {
        this.scheduler.enqueue(request);
      }
    } finally {
      this.isRequeueingDeferred = false;
    }
  }

  /**
   * Process the queue.
   *
   * Fair scheduling: the loop scans past requests whose domain limiter is
   * saturated and starts requests to ready domains. When every queued
   * request is limiter-blocked, it waits on the nearest limiter availability
   * instead of polling at a fixed interval.
   */
  private async processQueue(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    let startedCount = 0;
    let deferredCount = 0;
    let globalThrottleBlocked = false;
    let nearestDomainWaitMs = Number.POSITIVE_INFINITY;
    const requestsToStart: QueuedRequest[] = [];
    const deferred: QueuedRequest[] = [];

    try {
      // Get adaptive concurrency limit
      const maxConcurrency = this.throttlingManager.getAdaptiveConcurrency();

      while (
        this.activeRequests.size + requestsToStart.length <
        maxConcurrency
      ) {
        const request = this.scheduler.getNextRequest();

        if (!request) {
          break; // No more processable requests
        }

        // Check if we should throttle globally (memory/network pressure)
        if (this.throttlingManager.shouldThrottleRequest()) {
          deferred.push(request);
          globalThrottleBlocked = true;
          break;
        }

        // Check domain rate limiting — remember when this domain frees up
        // and keep scanning so other domains are not starved (no
        // head-of-line blocking).
        const domainLimiter = DomainLimiterFactory.getLimiter(request.domain);
        if (!domainLimiter.canMakeRequest()) {
          nearestDomainWaitMs = Math.min(
            nearestDomainWaitMs,
            Math.max(domainLimiter.getWaitTime(), 1),
          );
          deferred.push(request);
          deferredCount++;
          continue;
        }

        requestsToStart.push(request);
      }
    } catch {
      // Ignore
    }

    // Requests whose head domain is saturated go back, order preserved.
    this.requeueDeferred(deferred);

    // Start all eligible requests in parallel
    for (const request of requestsToStart) {
      // Start the request without awaiting to avoid blocking the queue processing
      this.startRequest(request).catch(() => {
        // Ignore
      });
    }

    if (!this.isProcessing || this.scheduler.isEmpty()) {
      return;
    }

    if (globalThrottleBlocked) {
      // Retry after the throttle delay has elapsed
      const throttleDelay = Math.max(
        this.throttlingManager.getThrottleDelay(),
        QUEUE_TICK_MS,
      );
      this.scheduleProcessing(throttleDelay);
    } else if (startedCount === 0 && deferredCount > 0) {
      // Every queued request is blocked by its domain limiter — wait for the
      // nearest limiter availability instead of busy-spinning.
      const waitMs = Math.min(
        Math.max(nearestDomainWaitMs, QUEUE_TICK_MS),
        MAX_SCHEDULE_DELAY_MS,
      );
      this.scheduleProcessing(waitMs);
    }
    // else: requests were started (or nothing is deferrable) — their
    // completion callbacks trigger the next processing cycle.
  }

  /**
   * Start a request
   */
  private async startRequest(request: QueuedRequest): Promise<void> {
    const startTime = Date.now();
    const controller = new AbortController();

    // Create active request
    const activeRequest: ActiveRequest = {
      request,
      controller,
      startTime,
      progress: {
        requestId: request.id,
        bytesDownloaded: 0,
        totalBytes: request.estimatedSize,
        progress: 0,
        downloadSpeed: 0,
        eta: 0,
      },
    };

    this.activeRequests.set(request.id, activeRequest);

    // Update domain limiter. Read the pending wait BEFORE recording the
    // dispatch — otherwise the just-recorded timestamp would count against
    // this very request and add a spurious full rate-window delay.
    const domainLimiter = DomainLimiterFactory.getLimiter(request.domain);
    const domainDelay = domainLimiter.getWaitTime();
    domainLimiter.startRequest();

    try {
      // Notify start
      if (this.options.eventListeners?.onStart) {
        this.options.eventListeners.onStart(request);
      }

      // Apply throttle delay if needed
      const throttleDelay = this.throttlingManager.getThrottleDelay();
      if (throttleDelay > 0) {
        await this.delay(throttleDelay);
      }

      // Apply domain rate limit delay if needed
      if (domainDelay > 0) {
        await this.delay(domainDelay);
      }

      // Execute the request
      const result = await this.executeRequest(request, controller);

      // Memory accounting: usage increases when the response is received
      // (actual byte length), and is released in `finally` below.
      memoryManager.trackResourceAllocation(request.id, result.size, {
        url: request.url,
        type: request.resourceType,
      });

      // Record success
      const duration = Date.now() - startTime;
      this.throttlingManager.recordRequest(duration, true);
      domainLimiter.adjustRateLimit(result.snapshot.status);

      // Complete the request
      this.completeRequest(request.id, result);
    } catch (error) {
      // Record failure
      const duration = Date.now() - startTime;
      this.throttlingManager.recordRequest(duration, false);

      // Adjust the domain limiter, threading Retry-After hints from
      // 429/Retry-After responses into the rate adjustment.
      const status =
        error instanceof RequestQueueError ? (error.status ?? 0) : 0;
      const retryAfterMs =
        error instanceof RequestQueueError ? error.retryAfterMs : undefined;
      domainLimiter.adjustRateLimit(status, retryAfterMs);

      // Fail the request
      this.failRequest(
        request.id,
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      // Memory accounting is bound to the request lifecycle: every exit path
      // (completed, failed, cancelled) releases the allocation.
      memoryManager.releaseResource(request.id);
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute a request with fallback strategies for CORS-blocked resources.
   *
   * - Enforces `requestTimeout` via a composite abort (external signal + timeout).
   * - Primary fetch sends `credentials: "include"`; a 4xx response is retried
   *   once with `credentials: "omit"`.
   * - Opaque (`no-cors`) responses are flagged on the result, never read.
   * - The no-cors fallback is kept only for images (cacheable/usable); the
   *   spec-illegal navigate-mode fallback has been removed.
   */
  private async executeRequest(
    request: QueuedRequest,
    controller: AbortController,
  ): Promise<RequestResult> {
    const startTime = Date.now();

    // Extract origin from request URL for Referer header
    let referer = "";
    try {
      const urlObj = new URL(request.url);
      referer = urlObj.origin + "/";
    } catch {
      // If URL parsing fails, skip referer
    }

    // Split caller hints that are not fetch-init properties
    const requestFetchOptions: Record<string, unknown> = {
      ...(request.fetchOptions ?? {}),
    };
    const timeoutHint =
      typeof requestFetchOptions.timeout === "number"
        ? requestFetchOptions.timeout
        : undefined;
    delete requestFetchOptions.timeout;
    delete requestFetchOptions.retries;
    const userHeaders = (requestFetchOptions.headers ?? {}) as Record<
      string,
      string
    >;
    delete requestFetchOptions.headers;

    // Enforce requestTimeout (callers may pass a per-request hint)
    const timeoutMs =
      timeoutHint ??
      this.options.throttling?.requestTimeout ??
      DEFAULT_THROTTLING_CONFIG.requestTimeout;
    const composite = createCompositeAbort(controller.signal, timeoutMs);

    const buildInit = (
      credentials: RequestCredentials,
      mode: RequestMode,
    ): RequestInit => ({
      method: "GET",
      mode,
      redirect: "follow",
      credentials,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: this.getAcceptHeader(request.resourceType),
        "Cache-Control": "no-cache",
        Referer: referer,
        Origin: referer ? referer.replace(/\/$/, "") : "",
        ...userHeaders,
      },
      ...requestFetchOptions,
      // The composite signal always wins — timeout and cancellation cannot
      // be bypassed by caller fetch options.
      signal: composite.signal,
    });

    let response: Response | undefined;
    let opaque = false;

    try {
      try {
        // Primary: credentialed fetch so session cookies reach
        // logged-in/private-CDN assets (host permissions cover <all_urls>).
        response = await fetch(request.url, buildInit("include", "cors"));

        if (!response.ok && response.status >= 400 && response.status < 500) {
          // One cookieless retry — some servers reject requests that carry
          // cookies they do not recognize.
          response = await fetch(request.url, buildInit("omit", "cors"));
        }

        if (!response.ok) {
          throw new RequestQueueError(
            `HTTP ${response.status}: ${response.statusText}`,
            "http",
            {
              status: response.status,
              retryAfterMs: parseRetryAfterHeader(response.headers),
            },
          );
        }
      } catch (error) {
        // Timeout and download-cancellation aborts are terminal.
        const abortError = classifyAbort(error, controller.signal, timeoutMs);
        if (abortError) {
          throw abortError;
        }

        // A definitive HTTP response (already retried cookieless on 4xx) is
        // terminal: the no-cors fallback exists for network/CORS-type
        // failures only, and re-requesting a 404/410/5xx would just add
        // fetches the spec forbids ("one cookieless retry on 4xx").
        if (error instanceof RequestQueueError && error.category === "http") {
          throw error;
        }

        // Network-level failure. Keep the no-cors fallback for images only
        // (cacheable/usable cases) — never for text or documents.
        if (request.resourceType !== ResourceType.IMAGE) {
          throw toRequestQueueError(error, "network");
        }

        try {
          response = await fetch(request.url, buildInit("omit", "no-cors"));
          opaque = response.type === "opaque";
          if (!opaque && !response.ok) {
            throw new RequestQueueError(
              `HTTP ${response.status}: ${response.statusText}`,
              "http",
              { status: response.status },
            );
          }
        } catch (fallbackError) {
          const fallbackAbort = classifyAbort(
            fallbackError,
            controller.signal,
            timeoutMs,
          );
          throw fallbackAbort ?? toRequestQueueError(fallbackError, "network");
        }
      }

      if (!response) {
        throw new RequestQueueError(
          `Failed to fetch ${request.url}: all strategies exhausted`,
          "network",
        );
      }

      // Read the body exactly once and keep an immutable snapshot; every
      // consumer gets an independently readable result. Opaque bodies are
      // never read — they are flagged instead.
      let bytes: Uint8Array | null = null;
      if (!opaque) {
        bytes = new Uint8Array(await response.arrayBuffer());
      }

      const snapshot: ResponseSnapshot = createResponseSnapshot(
        response,
        bytes,
      );
      if (opaque) {
        snapshot.type = "opaque";
      }

      const result: RequestResult = {
        requestId: request.id,
        url: request.url,
        duration: Date.now() - startTime,
        size: bytes ? bytes.byteLength : 0,
        fromCache: false,
        snapshot,
        type: snapshot.type,
        get response() {
          // Fresh Response per access — consumers never share a consumed body.
          return snapshotToResponse(snapshot);
        },
      };

      return result;
    } finally {
      composite.cleanup();
    }
  }

  /**
   * Complete a request
   */
  private completeRequest(requestId: string, result: RequestResult): void {
    const activeRequest = this.activeRequests.get(requestId);
    if (!activeRequest) {
      return;
    }

    // Update domain limiter
    const domainLimiter = DomainLimiterFactory.getLimiter(
      activeRequest.request.domain,
    );
    domainLimiter.completeRequest();

    // Remove from active requests
    this.activeRequests.delete(requestId);

    // Complete in scheduler
    this.scheduler.completeRequest(requestId, result);

    // Call completion callback
    if (activeRequest.request.onComplete) {
      activeRequest.request.onComplete(result);
    }

    // Trigger next processing cycle
    this.scheduleProcessing();
  }

  /**
   * Fail a request
   */
  private failRequest(requestId: string, error: Error): void {
    const activeRequest = this.activeRequests.get(requestId);
    if (!activeRequest) {
      return;
    }

    // Update domain limiter
    const domainLimiter = DomainLimiterFactory.getLimiter(
      activeRequest.request.domain,
    );
    domainLimiter.completeRequest();

    // Remove from active requests
    this.activeRequests.delete(requestId);

    // Fail in scheduler
    this.scheduler.failRequest(requestId, error);

    // Call error callback
    if (activeRequest.request.onError) {
      activeRequest.request.onError(error);
    }

    // Trigger next processing cycle
    this.scheduleProcessing();
  }

  /**
   * Check if an error is retryable (transient) or permanent
   * Permanent errors like 404, 403 should not be retried as they will always fail
   */
  private isRetryableError(error: Error): boolean {
    if (error instanceof RequestQueueError) {
      switch (error.category) {
        case "cancelled":
          // The download was stopped on purpose — never retry.
          return false;
        case "timeout":
          // A full requestTimeout already elapsed on the attempt and the
          // download has moved on (the asset is recorded as failed). A
          // detached retry would fire after finalization as an orphan fetch
          // whose result is never uploaded — terminal, like cancellation.
          return false;
        case "http": {
          const statusCode = error.status ?? 0;

          // 4xx Client Errors - generally not retryable. Exceptions:
          // 408 Request Timeout and 429 Too Many Requests.
          if (statusCode >= 400 && statusCode < 500) {
            return statusCode === 408 || statusCode === 429;
          }

          // 5xx server errors and anything else are transient.
          return true;
        }
        default:
          // Timeouts and network failures are transient.
          return true;
      }
    }

    // Legacy message-based classification for errors from other layers
    const message = error.message;

    const httpMatch = message.match(/HTTP (\d+)/);
    if (httpMatch) {
      const statusCode = parseInt(httpMatch[1]);

      if (statusCode >= 400 && statusCode < 500) {
        return statusCode === 408 || statusCode === 429;
      }
      if (statusCode >= 500) {
        return true;
      }
    }

    return true;
  }

  /**
   * Retry a request
   */
  private retryRequest(request: QueuedRequest): void {
    // Increment retry count
    request.retryCount++;

    // Calculate backoff delay
    const baseDelay =
      this.options.throttling?.backoffBase ??
      DEFAULT_THROTTLING_CONFIG.backoffBase;
    const maxDelay =
      this.options.throttling?.maxBackoffDelay ??
      DEFAULT_THROTTLING_CONFIG.maxBackoffDelay;
    const delay = Math.min(
      baseDelay * Math.pow(2, request.retryCount - 1),
      maxDelay,
    );

    // Schedule retry — tracked so a scoped/full clear can cancel it (an
    // untracked timer would re-enqueue after the download finished).
    const timer = setTimeout(() => {
      this.retryTimers.delete(request.id);
      // Re-queue the request
      this.scheduler.enqueue(request);

      // Notify retry
      if (this.options.eventListeners?.onRetry) {
        this.options.eventListeners.onRetry(request, request.retryCount);
      }
    }, delay);
    this.retryTimers.set(request.id, { timer, request });
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req-${Date.now()}-${++this.requestCounter}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get Accept header for resource type
   */
  private getAcceptHeader(resourceType: ResourceType): string {
    switch (resourceType) {
      case ResourceType.HTML:
        return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

      case ResourceType.CSS:
        return "text/css,*/*;q=0.1";

      case ResourceType.JS:
        return "application/javascript,text/javascript,*/*;q=0.1";

      case ResourceType.IMAGE:
        return "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

      case ResourceType.FONT:
        return "font/woff2,font/woff,font/ttf,font/otf,application/font-woff,*/*;q=0.1";

      case ResourceType.DOCUMENT:
        return "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.5";

      default:
        return "*/*";
    }
  }
}

// Singleton instance
export const requestQueue = new RequestQueue();

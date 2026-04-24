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
  QueueEventListeners,
  RequestQueueOptions,
  DEFAULT_QUEUE_OPTIONS,
  extractDomain,
  getResourceTypeFromUrl,
  getPriorityForResourceType,
} from '../types/queue';
import { RequestScheduler } from './RequestScheduler';
import { DomainLimiterFactory } from './DomainLimiter';
import { ThrottlingManager } from './ThrottlingManager';
import { memoryManager } from './MemoryManager';

export class RequestQueue {
  private options: RequestQueueOptions;
  private scheduler: RequestScheduler;
  private throttlingManager: ThrottlingManager;
  private activeRequests: Map<string, ActiveRequest> = new Map();
  private isProcessing: boolean = false;
  private processingTimer: NodeJS.Timeout | null = null;
  private requestCounter: number = 0;

  constructor(options?: Partial<RequestQueueOptions>) {
    this.options = { ...DEFAULT_QUEUE_OPTIONS, ...options };
    
    // Initialize components
    this.scheduler = new RequestScheduler(this.options.eventListeners);
    this.throttlingManager = new ThrottlingManager(this.options.throttling);
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Start processing
    this.startProcessing();
  }

  /**
   * Add a request to the queue
   */
  public async enqueue(request: Omit<QueuedRequest, 'id' | 'status' | 'queuedAt'>): Promise<string> {
    // Generate unique ID
    const id = this.generateRequestId();
    
    // Extract domain
    const domain = extractDomain(request.url);
    
    // Determine resource type if not provided
    const resourceType = request.resourceType || getResourceTypeFromUrl(request.url);
    
    // Determine priority if not provided
    const priority = request.priority || getPriorityForResourceType(resourceType);
    
    // Check for duplicates
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
    // Try to cancel in scheduler first
    if (this.scheduler.cancelRequest(requestId)) {
      return true;
    }

    // Try to cancel active request
    const activeRequest = this.activeRequests.get(requestId);
    if (activeRequest) {
      activeRequest.controller.abort();
      this.activeRequests.delete(requestId);
      return true;
    }

    return false;
  }

  /**
   * Pause processing
   */
  public pause(): void {
    this.isProcessing = false;
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
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
   * Clear all requests
   */
  public clear(): void {
    // Cancel all active requests
    for (const activeRequest of this.activeRequests.values()) {
      activeRequest.controller.abort();
    }
    this.activeRequests.clear();

    // Clear scheduler
    this.scheduler.clear();
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
        this.scheduleProcessing();
      },
      
      onStart: (request) => {
        if (originalListeners.onStart) {
          originalListeners.onStart(request);
        }
      },
      
      onComplete: (result) => {
        // Cache successful results
        this.throttlingManager.cacheRequestResult(result.url, result);
        
        if (originalListeners.onComplete) {
          originalListeners.onComplete(result);
        }
      },
      
      onError: (request, error) => {
        // Handle retries - only retry transient errors, not permanent ones
        const shouldRetry = request.retryCount < (this.options.throttling?.maxRetries || 3) && 
                           this.isRetryableError(error);
        
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
   * Schedule next processing cycle
   */
  private scheduleProcessing(): void {
    if (!this.isProcessing || this.processingTimer) {
      return;
    }

    this.processingTimer = setTimeout(() => {
      this.processingTimer = null;
      this.processQueue();
    }, 10); // Process every 10ms (reduced from 100ms for faster response)
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    try {
      // Get adaptive concurrency limit
      const maxConcurrency = this.throttlingManager.getAdaptiveConcurrency();
      const currentActiveRequests = this.activeRequests.size;
      
      // Process multiple requests in parallel up to concurrency limit
      const requestsToStart: QueuedRequest[] = [];
      
      while (currentActiveRequests + requestsToStart.length < maxConcurrency) {
        const request = this.scheduler.getNextRequest();
        
        if (!request) {
          break; // No more requests to process
        }

        // Check if we should throttle
        if (this.throttlingManager.shouldThrottleRequest()) {
          // Put request back and wait
          this.scheduler.enqueue(request);
          break;
        }

        // Check domain rate limiting
        const domainLimiter = DomainLimiterFactory.getLimiter(request.domain);
        if (!domainLimiter.canMakeRequest()) {
          // Put request back and wait
          this.scheduler.enqueue(request);
          break;
        }

        requestsToStart.push(request);
      }

      // Start all eligible requests in parallel
      for (const request of requestsToStart) {
        // Start the request without awaiting to avoid blocking the queue processing
        this.startRequest(request).catch(() => {
          // Ignore
        });
      }
    } catch {
      // Ignore
    }

    // Schedule next processing only if we have more items and not paused
    if (this.isProcessing && !this.scheduler.isEmpty()) {
       this.scheduleProcessing();
    }
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
    
    // Update domain limiter
    const domainLimiter = DomainLimiterFactory.getLimiter(request.domain);
    domainLimiter.startRequest();
    
    // Track memory allocation
    memoryManager.queueResource({
      id: request.id,
      url: request.url,
      type: request.resourceType,
      size: request.estimatedSize,
      status: 'downloading',
    });
    
    try {
      // Notify start
      if (this.options.eventListeners?.onStart) {
        this.options.eventListeners.onStart(request);
      }

      // Apply throttle delay if needed
      const throttleDelay = this.throttlingManager.getThrottleDelay();
      if (throttleDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, throttleDelay));
      }

      // Apply domain rate limit delay if needed
      const domainDelay = domainLimiter.getWaitTime();
      if (domainDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, domainDelay));
      }

      // Execute the request
      const result = await this.executeRequest(request, controller);
      
      // Record success
      const duration = Date.now() - startTime;
      this.throttlingManager.recordRequest(duration, true);
      domainLimiter.adjustRateLimit(result.response.status);
      
      // Update memory tracking
      memoryManager.trackResourceAllocation(request.id, result.size);
      
      // Complete the request
      this.completeRequest(request.id, result);
      
    } catch (error) {
      // Record failure
      const duration = Date.now() - startTime;
      this.throttlingManager.recordRequest(duration, false);
      
      // Get status code if available
      let statusCode = 0;
      if (error instanceof Error) {
        const statusMatch = error.message.match(/HTTP (\d+)/);
        if (statusMatch) {
          statusCode = parseInt(statusMatch[1]);
        }
      }
      
      domainLimiter.adjustRateLimit(statusCode);
      
      // Fail the request
      this.failRequest(request.id, error as Error);
    }
  }

  /**
   * Execute a request with fallback strategies for CORS-blocked resources
   */
  private async executeRequest(request: QueuedRequest, controller: AbortController): Promise<RequestResult> {
    const startTime = Date.now();
    
    // Extract origin from request URL for Referer header
    let referer = '';
    try {
      const urlObj = new URL(request.url);
      referer = urlObj.origin + '/';
    } catch (e) {
      // If URL parsing fails, skip referer
    }
    
    // Prepare fetch options
    const fetchOptions: RequestInit = {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': this.getAcceptHeader(request.resourceType),
        'Cache-Control': 'no-cache',
        'Referer': referer,
        'Origin': referer ? referer.replace(/\/$/, '') : '',
        ...request.fetchOptions?.headers,
      },
      ...request.fetchOptions,
    };

    let response: Response | undefined;
    
    try {
      // Make the request
      response = await fetch(request.url, fetchOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      // If standard fetch fails, try fallback strategies.
      // For CSS/JS/Images: no-cors mode (opaque response OK for some use cases),
      // then navigate mode as last resort.
      // For Documents: skip no-cors (opaque responses can't be read — .blob()
      // throws) and go directly to navigate mode which returns readable responses.
      const needsFallback = request.resourceType === ResourceType.CSS
        || request.resourceType === ResourceType.JS
        || request.resourceType === ResourceType.IMAGE
        || request.resourceType === ResourceType.DOCUMENT;

      if (needsFallback) {
        // For documents, skip no-cors and go straight to navigate mode
        // since opaque responses can't be read (blob()/text() throw TypeError).
        if (request.resourceType !== ResourceType.DOCUMENT) {
          try {
            response = await fetch(request.url, {
              method: 'GET',
              mode: 'no-cors',
              cache: 'no-cache',
              credentials: 'omit',
              signal: controller.signal,
              headers: {
                'Accept': this.getAcceptHeader(request.resourceType),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
            });

            // no-cors mode will return opaque responses, which is expected
            if (response.type === 'opaque') {
            }
          } catch (fallbackError) {
            // If no-cors fails, fall through to navigate mode below
          }
        }

        // If we still don't have a usable response (or resource type is DOCUMENT),
        // try navigate mode which bypasses CORS and returns readable responses.
        if (response === undefined || (response.type === 'opaque' && request.resourceType === ResourceType.DOCUMENT)) {
          try {
            response = await fetch(request.url, {
              method: 'GET',
              mode: 'navigate',
              cache: 'force-cache',
              redirect: 'follow',
              signal: controller.signal,
            });
          } catch (navigateError) {
            // All strategies failed, re-throw the original error
            throw error;
          }
        }
      } else {
        // For other resource types, just re-throw the error
        throw error;
      }
    }

    // If all fetch strategies failed, throw the error
    if (!response) {
      throw new Error(`Failed to fetch ${request.url}: all strategies exhausted`);
    }

    // Get response size
    const contentLength = response.headers.get('Content-Length');
    const size = contentLength ? parseInt(contentLength) : 0;
    
    // Create result
    const result: RequestResult = {
      requestId: request.id,
      url: request.url,
      response,
      duration: Date.now() - startTime,
      size,
      fromCache: false, // We could check cache headers here
    };

    return result;
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
    const domainLimiter = DomainLimiterFactory.getLimiter(activeRequest.request.domain);
    domainLimiter.completeRequest();
    
    // Release memory
    memoryManager.releaseResource(requestId);
    
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
    const domainLimiter = DomainLimiterFactory.getLimiter(activeRequest.request.domain);
    domainLimiter.completeRequest();
    
    // Release memory
    memoryManager.releaseResource(requestId);
    
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
    const message = error.message;
    
    // Check for HTTP status codes in the error message
    const httpMatch = message.match(/HTTP (\d+)/);
    if (httpMatch) {
      const statusCode = parseInt(httpMatch[1]);
      
      // 4xx Client Errors - generally not retryable (resource doesn't exist or access denied)
      // Exceptions:
      // - 408 Request Timeout - retryable
      // - 429 Too Many Requests - retryable (rate limiting)
      if (statusCode >= 400 && statusCode < 500) {
        if (statusCode === 408 || statusCode === 429) {
          return true; // These are retryable
        }
        return false; // Other 4xx errors are permanent
      }
      
      // 5xx Server Errors - generally retryable (server issues may be temporary)
      if (statusCode >= 500) {
        return true;
      }
    }
    
    // Network errors, timeouts, and other transient issues are retryable
    // These typically don't have HTTP status codes
    return true;
  }

  /**
   * Retry a request
   */
  private retryRequest(request: QueuedRequest): void {
    // Increment retry count
    request.retryCount++;
    
    // Calculate backoff delay
    const baseDelay = this.options.throttling?.backoffBase || 1000;
    const maxDelay = this.options.throttling?.maxBackoffDelay || 10000;
    const delay = Math.min(baseDelay * Math.pow(2, request.retryCount - 1), maxDelay);
    
    // Schedule retry
    setTimeout(() => {
      // Re-queue the request
      this.scheduler.enqueue(request);
      
      // Notify retry
      if (this.options.eventListeners?.onRetry) {
        this.options.eventListeners.onRetry(request, request.retryCount);
      }
    }, delay);
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
        return 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
      
      case ResourceType.CSS:
        return 'text/css,*/*;q=0.1';
      
      case ResourceType.JS:
        return 'application/javascript,text/javascript,*/*;q=0.1';
      
      case ResourceType.IMAGE:
        return 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
      
      case ResourceType.FONT:
        return 'font/woff2,font/woff,font/ttf,font/otf,application/font-woff,*/*;q=0.1';
      
      case ResourceType.DOCUMENT:
        return 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.5';
      
      default:
        return '*/*';
    }
  }
}

// Singleton instance
export const requestQueue = new RequestQueue();
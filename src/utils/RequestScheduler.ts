/**
 * Request Scheduler
 * Implements priority-based scheduling with dependency resolution
 */

import {
  QueuedRequest,
  RequestStatus,
  ResourceType,
  QueueEventListeners,
  RequestResult,
  getPriorityForResourceType,
} from "../types/queue";

export class RequestScheduler {
  private queue: QueuedRequest[] = [];
  private activeRequests: Map<string, QueuedRequest> = new Map();
  private completedRequests: Set<string> = new Set();
  private failedRequests: Set<string> = new Set();
  private eventListeners: QueueEventListeners = {};
  private processingTimer: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;
  /** While paused, the 1 ms self-rescheduling loop stays stopped (design D3). */
  private paused: boolean = false;

  // Statistics
  private totalProcessed: number = 0;
  private totalDuration: number = 0;
  private lastProcessTime: number = 0;

  constructor(eventListeners?: QueueEventListeners) {
    this.eventListeners = eventListeners || {};
    this.startProcessing();
  }

  /**
   * Add a request to the queue
   */
  public enqueue(request: QueuedRequest): void {
    // Set default priority if not provided
    if (request.priority === undefined) {
      request.priority = getPriorityForResourceType(request.resourceType);
    }

    // Set status to queued
    request.status = RequestStatus.QUEUED;
    request.queuedAt = Date.now();

    // Add to queue
    this.queue.push(request);

    // Sort queue by priority and dependencies
    this.sortQueue();

    // Notify listeners
    if (this.eventListeners.onQueued) {
      this.eventListeners.onQueued(request);
    }

    // Trigger processing
    this.scheduleProcessing();
  }

  /**
   * Get the next request to process
   */
  public getNextRequest(): QueuedRequest | null {
    if (this.queue.length === 0) {
      return null;
    }

    // Find the first request that can be processed
    for (let i = 0; i < this.queue.length; i++) {
      const request = this.queue[i];

      if (this.canProcessRequest(request)) {
        // Remove from queue and mark as active
        this.queue.splice(i, 1);
        request.status = RequestStatus.PENDING;
        request.startedAt = Date.now();
        this.activeRequests.set(request.id, request);

        return request;
      }
    }

    return null;
  }

  /**
   * Mark a request as completed
   */
  public completeRequest(requestId: string, result: RequestResult): void {
    const request = this.activeRequests.get(requestId);
    if (!request) {
      return;
    }

    // Update request status
    request.status = RequestStatus.COMPLETED;
    request.completedAt = Date.now();

    // Update statistics
    const duration =
      request.completedAt - (request.startedAt || request.queuedAt);
    this.totalProcessed++;
    this.totalDuration += duration;

    // Move to completed set
    this.activeRequests.delete(requestId);
    this.completedRequests.add(requestId);

    // Notify listeners
    if (this.eventListeners.onComplete) {
      this.eventListeners.onComplete(result);
    }

    // Schedule next processing
    this.scheduleProcessing();
  }

  /**
   * Mark a request as failed
   */
  public failRequest(requestId: string, error: Error): void {
    const request = this.activeRequests.get(requestId);
    if (!request) {
      return;
    }

    // Update request status
    request.status = RequestStatus.FAILED;
    request.error = error.message;
    request.completedAt = Date.now();

    // Move to failed set
    this.activeRequests.delete(requestId);
    this.failedRequests.add(requestId);

    // Notify listeners
    if (this.eventListeners.onError) {
      this.eventListeners.onError(request, error);
    }

    // Schedule next processing
    this.scheduleProcessing();
  }

  /**
   * Retry a failed request
   */
  public retryRequest(requestId: string): boolean {
    // Check if request exists in failed set
    if (!this.failedRequests.has(requestId)) {
      return false;
    }

    // Find the request in our tracking (we need to reconstruct it)
    // In a real implementation, we'd keep the full request object
    // For now, we'll just remove it from failed set
    this.failedRequests.delete(requestId);

    // The caller should re-enqueue the request with updated retry count
    return true;
  }

  /**
   * Cancel a request
   */
  public cancelRequest(requestId: string): boolean {
    // Check if request is in queue
    const queueIndex = this.queue.findIndex((req) => req.id === requestId);
    if (queueIndex !== -1) {
      const request = this.queue.splice(queueIndex, 1)[0];
      request.status = RequestStatus.CANCELLED;
      return true;
    }

    // Check if request is active
    if (this.activeRequests.has(requestId)) {
      const request = this.activeRequests.get(requestId)!;
      request.status = RequestStatus.CANCELLED;
      this.activeRequests.delete(requestId);
      return true;
    }

    return false;
  }

  /**
   * Get queue statistics
   */
  public getStats(): {
    queued: number;
    active: number;
    completed: number;
    failed: number;
    totalProcessed: number;
    averageDuration: number;
    processingRate: number;
  } {
    return {
      queued: this.queue.length,
      active: this.activeRequests.size,
      completed: this.completedRequests.size,
      failed: this.failedRequests.size,
      totalProcessed: this.totalProcessed,
      averageDuration:
        this.totalProcessed > 0 ? this.totalDuration / this.totalProcessed : 0,
      processingRate: this.calculateProcessingRate(),
    };
  }

  /**
   * Get all queued requests
   */
  public getQueuedRequests(): QueuedRequest[] {
    return [...this.queue];
  }

  /**
   * Get all active requests
   */
  public getActiveRequests(): QueuedRequest[] {
    return Array.from(this.activeRequests.values());
  }

  /**
   * Check if queue is empty
   */
  public isEmpty(): boolean {
    return this.queue.length === 0 && this.activeRequests.size === 0;
  }

  /**
   * Update event listeners
   */
  public setEventListeners(listeners: QueueEventListeners): void {
    this.eventListeners = listeners;
  }

  /**
   * Remove still-queued requests belonging to ONE download (scoped clear,
   * concurrent-downloads spec / design D7). Returns the removed requests so
   * the caller can settle their callbacks — dropping a queued request without
   * settling leaves the awaiting handler promise pending forever.
   *
   * Active requests are deliberately untouched: cancelling in-flight work is
   * the queue's job via each request's abort controller, after which the
   * normal failure path removes them from the active map.
   */
  public removeQueuedForDownload(downloadId: string): QueuedRequest[] {
    const kept: QueuedRequest[] = [];
    const removed: QueuedRequest[] = [];
    for (const request of this.queue) {
      if (request.downloadId === downloadId) {
        removed.push(request);
      } else {
        kept.push(request);
      }
    }
    this.queue = kept;
    for (const request of removed) {
      request.status = RequestStatus.CANCELLED;
    }
    return removed;
  }

  /**
   * Clear the queue (cancel all requests). Returns ALL removed requests —
   * still-queued AND active — so the caller can settle their callbacks:
   * dropping either kind without settling leaves the awaiting handler
   * promise pending forever. (Active entries carry no abort logic here —
   * aborting in-flight fetches is the caller's job; this only guarantees no
   * dropped request lacks a settlement owner.)
   */
  public clear(): QueuedRequest[] {
    // Cancel all queued requests
    const removed = this.queue;
    // A limiter-deferred request can sit in BOTH the queue and the active
    // map (getNextRequest() moves it to active before the queue re-enqueues
    // it while deferral lasts). Dedupe by id so it is returned exactly once
    // — the caller settles every entry, so a duplicate here means a
    // double-settled handler.
    const seen = new Set<string>();
    for (const request of removed) {
      request.status = RequestStatus.CANCELLED;
      seen.add(request.id);
    }
    this.queue = [];

    // Cancel all active requests — surfaced to the caller alongside the
    // queued ones instead of being silently dropped.
    for (const request of this.activeRequests.values()) {
      request.status = RequestStatus.CANCELLED;
      if (!seen.has(request.id)) {
        seen.add(request.id);
        removed.push(request);
      }
    }
    this.activeRequests.clear();

    // Clear tracking sets
    this.completedRequests.clear();
    this.failedRequests.clear();

    // Reset statistics
    this.totalProcessed = 0;
    this.totalDuration = 0;

    return removed;
  }

  /**
   * Pause the processing loop: no timer is armed while paused, so a queued
   * backlog costs no busy work. `shutdown()` still overrides this.
   */
  public pause(): void {
    this.paused = true;
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }
  }

  /**
   * Resume the processing loop, restarting processing of queued work.
   */
  public resume(): void {
    this.paused = false;
    this.scheduleProcessing();
  }

  /**
   * Shutdown the scheduler
   */
  public shutdown(): void {
    this.clear();

    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }

    this.isProcessing = false;
    // Shutdown overrides pause: the scheduler ends fully stopped, not
    // parked in a paused state.
    this.paused = false;
  }

  /**
   * Sort the queue by priority and dependencies
   */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      // First by priority (lower number = higher priority)
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      // Then by resource type priority
      const typePriority =
        this.getResourceTypePriority(a.resourceType) -
        this.getResourceTypePriority(b.resourceType);
      if (typePriority !== 0) {
        return typePriority;
      }

      // Then by dependencies (fewer dependencies first)
      if (a.dependencies.length !== b.dependencies.length) {
        return a.dependencies.length - b.dependencies.length;
      }

      // Finally by queue time (earlier first)
      return a.queuedAt - b.queuedAt;
    });
  }

  /**
   * Check if a request can be processed
   */
  private canProcessRequest(request: QueuedRequest): boolean {
    // Check if all dependencies are completed
    for (const depId of request.dependencies) {
      if (!this.completedRequests.has(depId)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get priority for resource type
   */
  private getResourceTypePriority(type: ResourceType): number {
    switch (type) {
      case ResourceType.HTML:
        return 1;
      case ResourceType.CSS:
        return 2;
      case ResourceType.JS:
        return 3;
      case ResourceType.FONT:
        return 4;
      case ResourceType.IMAGE:
        return 5;
      case ResourceType.DOCUMENT:
        return 6;
      case ResourceType.VIDEO:
      case ResourceType.AUDIO:
        return 7;
      default:
        return 8;
    }
  }

  /**
   * Calculate current processing rate
   */
  private calculateProcessingRate(): number {
    const now = Date.now();
    const timeSinceLastProcess = now - this.lastProcessTime;

    if (timeSinceLastProcess === 0) {
      return 0;
    }

    // Calculate requests per second over the last time window
    const timeWindow = 5000; // 5 seconds
    const recentRequests = this.getRecentCompletedRequests(timeWindow);

    return recentRequests / (timeWindow / 1000);
  }

  /**
   * Get count of recently completed requests
   */
  private getRecentCompletedRequests(timeWindow: number): number {
    // This is a simplified implementation
    // In a real implementation, we'd track completion timestamps
    return Math.min(this.totalProcessed, Math.floor(timeWindow / 1000));
  }

  /**
   * Start the processing loop
   */
  private startProcessing(): void {
    this.isProcessing = true;
    this.scheduleProcessing();
  }

  /**
   * Schedule the next processing cycle
   */
  private scheduleProcessing(): void {
    // Paused: no self-rescheduling — resume() re-arms the loop.
    if (this.paused || this.processingTimer) {
      return;
    }

    this.processingTimer = setTimeout(() => {
      this.processingTimer = null;
      this.processQueue();
    }, 1); // Process every 1ms (reduced from 10ms for faster response)
  }

  /**
   * Process the queue
   */
  private processQueue(): void {
    if (!this.isProcessing || this.paused) {
      return;
    }

    // Check if queue is empty
    if (this.isEmpty()) {
      if (this.eventListeners.onEmpty) {
        this.eventListeners.onEmpty();
      }
      return;
    }

    this.lastProcessTime = Date.now();

    // Continue processing
    this.scheduleProcessing();
  }
}

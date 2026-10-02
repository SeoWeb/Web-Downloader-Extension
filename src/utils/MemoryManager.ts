/**
 * Memory Manager for WebsiteDownloader Extension
 * Provides real-time memory monitoring, resource tracking, and automatic cleanup
 */

import {
  MemoryLimitsConfig,
  MemoryPressureLevel,
  DEFAULT_MEMORY_LIMITS,
  RESOURCE_SIZE_LIMITS,
} from "./memoryLimits";

export interface ResourceRequest {
  id: string;
  url: string;
  type: string;
  size: number;
  timestamp: number;
  status: "pending" | "downloading" | "completed" | "failed";
}

export interface MemoryStats {
  totalMemoryUsed: number;
  totalMemoryLimit: number;
  activeDownloads: number;
  queuedDownloads: number;
  completedDownloads: number;
  failedDownloads: number;
  memoryPressureLevel: MemoryPressureLevel;
  estimatedHeapSize?: number;
}

export class MemoryManager {
  private readonly config: MemoryLimitsConfig;
  private currentUsage: number = 0;
  private resourceQueue: ResourceRequest[] = [];
  private activeRequests: Set<string> = new Set();
  private completedRequests: Map<string, ResourceRequest> = new Map();
  private memoryCheckInterval: NodeJS.Timeout | null = null;
  private gcHintInterval: NodeJS.Timeout | null = null;
  private cleanupCallbacks: Array<() => Promise<void>> = [];
  private memoryPressureCallbacks: Array<(level: MemoryPressureLevel) => void> =
    [];

  constructor(config: Partial<MemoryLimitsConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_LIMITS, ...config };
    this.startMemoryMonitoring();
  }

  /**
   * Get current memory statistics
   */
  public getMemoryStats(): MemoryStats {
    const pressureLevel = this.getMemoryPressureLevel();
    const estimatedHeapSize = this.getEstimatedHeapSize();

    return {
      totalMemoryUsed: this.currentUsage,
      totalMemoryLimit: this.config.MAX_TOTAL_MEMORY_USAGE,
      activeDownloads: this.activeRequests.size,
      queuedDownloads: this.resourceQueue.length,
      completedDownloads: this.completedRequests.size,
      failedDownloads: Array.from(this.completedRequests.values()).filter(
        (req) => req.status === "failed",
      ).length,
      memoryPressureLevel: pressureLevel,
      estimatedHeapSize,
    };
  }

  /**
   * Check if there's enough memory available for a resource of given size
   */
  public checkMemoryAvailability(requestedSize: number): boolean {
    const projectedUsage = this.currentUsage + requestedSize;
    return projectedUsage <= this.config.MAX_TOTAL_MEMORY_USAGE;
  }

  /**
   * Check if a resource should be skipped based on its size
   */
  public shouldSkipResource(url: string, type: string, size: number): boolean {
    const limit =
      RESOURCE_SIZE_LIMITS[
        type.toUpperCase() as keyof typeof RESOURCE_SIZE_LIMITS
      ] || RESOURCE_SIZE_LIMITS.DEFAULT;

    if (size > this.config.MAX_RESOURCE_SIZE) {
      return true;
    }

    if (size > limit) {
      return true;
    }

    if (url) {
      // TODO: Do we need url?
    }

    return false;
  }

  /**
   * Get optimal concurrency level based on current memory usage
   */
  public getOptimalConcurrency(): number {
    const pressureLevel = this.getMemoryPressureLevel();

    switch (pressureLevel) {
      case MemoryPressureLevel.CRITICAL:
        return Math.max(
          1,
          Math.floor(this.config.MAX_CONCURRENT_REQUESTS * 0.2),
        );
      case MemoryPressureLevel.HIGH:
        return Math.max(
          2,
          Math.floor(this.config.MAX_CONCURRENT_REQUESTS * 0.5),
        );
      case MemoryPressureLevel.MEDIUM:
        return Math.floor(this.config.MAX_CONCURRENT_REQUESTS * 0.75);
      case MemoryPressureLevel.LOW:
      default:
        return this.config.MAX_CONCURRENT_REQUESTS;
    }
  }

  /**
   * Add a resource request to the queue
   */
  public queueResource(request: Omit<ResourceRequest, "timestamp">): string {
    const fullRequest: ResourceRequest = {
      ...request,
      timestamp: Date.now(),
    };

    this.resourceQueue.push(fullRequest);

    // Process queue asynchronously
    setTimeout(() => this.processQueue(), 0);

    return fullRequest.id;
  }

  /**
   * Track memory allocation for a resource
   */
  public trackResourceAllocation(resourceId: string, size: number): void {
    this.currentUsage += size;
    this.activeRequests.add(resourceId);

    // Update the request in the queue or completed requests
    const request =
      this.resourceQueue.find((r) => r.id === resourceId) ||
      this.completedRequests.get(resourceId);

    if (request) {
      request.size = size;
      request.status = "downloading";
    }

    // Check memory pressure
    const pressureLevel = this.getMemoryPressureLevel();
    if (pressureLevel >= MemoryPressureLevel.HIGH) {
      this.handleMemoryPressure(pressureLevel);
    }
  }

  /**
   * Release memory when a resource is completed or failed
   */
  public releaseResource(resourceId: string): void {
    const request =
      this.resourceQueue.find((r) => r.id === resourceId) ||
      this.completedRequests.get(resourceId);

    if (request) {
      this.currentUsage = Math.max(0, this.currentUsage - request.size);
      this.activeRequests.delete(resourceId);
      this.completedRequests.set(resourceId, {
        ...request,
        status: "completed",
      });
    }
  }

  /**
   * Mark a resource as failed and clean up
   */
  public markResourceFailed(resourceId: string): void {
    const request = this.resourceQueue.find((r) => r.id === resourceId);

    if (request) {
      this.currentUsage = Math.max(0, this.currentUsage - request.size);
      this.activeRequests.delete(resourceId);
      request.status = "failed";
      this.completedRequests.set(resourceId, request);
    }
  }

  /**
   * Register a cleanup callback
   */
  public registerCleanupCallback(callback: () => Promise<void>): void {
    this.cleanupCallbacks.push(callback);
  }

  /**
   * Register a memory pressure callback
   */
  public registerMemoryPressureCallback(
    callback: (level: MemoryPressureLevel) => void,
  ): void {
    this.memoryPressureCallbacks.push(callback);
  }

  /**
   * Force immediate cleanup of all resources
   */
  public async forceCleanup(): Promise<void> {
    // Run all cleanup callbacks
    const cleanupPromises = this.cleanupCallbacks.map((callback) => callback());

    await Promise.allSettled(cleanupPromises);

    // Clear completed requests older than max age
    this.cleanupOldCompletedRequests();

    // Suggest garbage collection
    if (typeof gc !== "undefined") {
      gc();
    }
  }

  /**
   * Shutdown the memory manager and cleanup all resources
   */
  public async shutdown(): Promise<void> {
    // Stop monitoring intervals
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
      this.memoryCheckInterval = null;
    }

    if (this.gcHintInterval) {
      clearInterval(this.gcHintInterval);
      this.gcHintInterval = null;
    }

    // Force cleanup
    await this.forceCleanup();

    // Clear all tracking data
    this.resourceQueue = [];
    this.activeRequests.clear();
    this.completedRequests.clear();
    this.currentUsage = 0;
    this.cleanupCallbacks = [];
    this.memoryPressureCallbacks = [];
  }

  /**
   * Process the resource queue based on available memory and concurrency limits
   */
  private async processQueue(): Promise<void> {
    const maxConcurrency = this.getOptimalConcurrency();

    while (
      this.activeRequests.size < maxConcurrency &&
      this.resourceQueue.length > 0
    ) {
      const request = this.resourceQueue.shift();

      if (!request) break;

      // Check if we have enough memory for this request
      if (!this.checkMemoryAvailability(request.size)) {
        // Put it back in the queue and stop processing
        this.resourceQueue.unshift(request);
        break;
      }

      // Start processing this request
      this.activeRequests.add(request.id);
    }
  }

  /**
   * Handle memory pressure situations
   */
  private async handleMemoryPressure(
    level: MemoryPressureLevel,
  ): Promise<void> {
    // Notify callbacks
    this.memoryPressureCallbacks.forEach((callback) => {
      try {
        callback(level);
      } catch {
        // Ignore
      }
    });

    if (level === MemoryPressureLevel.CRITICAL) {
      // Force cleanup in critical situations
      await this.forceCleanup();

      // Reduce queue processing
      this.resourceQueue.splice(Math.floor(this.resourceQueue.length / 2));
    }
  }

  /**
   * Start background memory monitoring
   */
  private startMemoryMonitoring(): void {
    // Periodic memory checks
    this.memoryCheckInterval = setInterval(() => {
      this.performMemoryCheck();
    }, this.config.MEMORY_CHECK_INTERVAL);

    // Periodic garbage collection hints
    this.gcHintInterval = setInterval(() => {
      if (typeof gc !== "undefined") {
        gc();
      }
    }, this.config.GC_HINT_INTERVAL);

    // Cleanup on service worker shutdown
    if (typeof self !== "undefined" && "addEventListener" in self) {
      self.addEventListener("beforeunload", () => {
        this.shutdown();
      });
    }
  }

  /**
   * Perform periodic memory checks
   */
  private performMemoryCheck(): void {
    const pressureLevel = this.getMemoryPressureLevel();

    if (pressureLevel >= MemoryPressureLevel.HIGH) {
      this.cleanupOldCompletedRequests();
    }

    // Continue processing queue if there's capacity
    if (
      this.resourceQueue.length > 0 &&
      this.activeRequests.size < this.getOptimalConcurrency()
    ) {
      this.processQueue();
    }
  }

  /**
   * Clean up old completed requests
   */
  private cleanupOldCompletedRequests(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    this.completedRequests.forEach((request, id) => {
      if (now - request.timestamp > this.config.MAX_BLOB_AGE) {
        toDelete.push(id);
      }
    });

    toDelete.forEach((id) => this.completedRequests.delete(id));
  }

  /**
   * Get current memory pressure level
   */
  private getMemoryPressureLevel(): MemoryPressureLevel {
    const usageRatio = this.currentUsage / this.config.MAX_TOTAL_MEMORY_USAGE;

    if (usageRatio >= this.config.PAUSE_THRESHOLD) {
      return MemoryPressureLevel.CRITICAL;
    } else if (usageRatio >= this.config.CLEANUP_THRESHOLD) {
      return MemoryPressureLevel.HIGH;
    } else if (usageRatio >= 0.5) {
      return MemoryPressureLevel.MEDIUM;
    } else {
      return MemoryPressureLevel.LOW;
    }
  }

  /**
   * Get estimated heap size from performance.memory if available
   */
  private getEstimatedHeapSize(): number | undefined {
    if (typeof performance !== "undefined") {
      const performanceMemory = (performance as any).memory;
      if (performanceMemory) {
        return performanceMemory.usedJSHeapSize;
      }
    }
    return undefined;
  }
}

// Singleton instance
export const memoryManager = new MemoryManager();

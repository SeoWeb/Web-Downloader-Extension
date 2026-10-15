/**
 * Memory Manager for WebsiteDownloader Extension
 * Provides real-time memory monitoring, resource tracking, and automatic cleanup
 *
 * Accounting model: `currentUsage` is derived from the set of ACTIVE
 * allocations (in-flight requests whose response has been received). Every
 * tracked allocation has an active record, `releaseResource` always matches a
 * record (unknown ids are a warned no-op), and `forceCleanup` recomputes
 * usage from the live records so a stale high-water mark can never stall
 * downloads.
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

/** Optional metadata supplied when tracking an allocation. */
export interface AllocationInfo {
  url?: string;
  type?: string;
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
  /** Pending records registered via queueResource (statistics only). */
  private resourceQueue: ResourceRequest[] = [];
  /** In-flight allocations — the source of truth behind currentUsage. */
  private activeAllocations: Map<string, ResourceRequest> = new Map();
  private completedRequests: Map<string, ResourceRequest> = new Map();
  private memoryCheckInterval: NodeJS.Timeout | null = null;
  private gcHintInterval: NodeJS.Timeout | null = null;
  private cleanupCallbacks: Array<() => Promise<void>> = [];
  private memoryPressureCallbacks: Array<(level: MemoryPressureLevel) => void> =
    [];
  /** Last level reported to pressure callbacks — transitions fire exactly once. */
  private lastNotifiedLevel: MemoryPressureLevel | null = null;

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
      activeDownloads: this.activeAllocations.size,
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
   * Register a resource as queued.
   *
   * This only records statistics — actual memory accounting happens in
   * `trackResourceAllocation`/`releaseResource`, which the RequestQueue binds
   * to the real request lifecycle (allocate on response, release in `finally`).
   */
  public queueResource(request: Omit<ResourceRequest, "timestamp">): string {
    // Drop stale pending records so the list cannot grow unbounded when
    // callers never reach the allocation step (skipped/failed requests).
    this.pruneStalePendingRequests();

    const fullRequest: ResourceRequest = {
      ...request,
      timestamp: Date.now(),
    };

    this.resourceQueue.push(fullRequest);

    return fullRequest.id;
  }

  /**
   * Track memory allocation for an in-flight resource. Called by the
   * RequestQueue when a request's response has been received, with the actual
   * response size (Content-Length or byte length).
   */
  public trackResourceAllocation(
    resourceId: string,
    size: number,
    info?: AllocationInfo,
  ): void {
    const safeSize = Number.isFinite(size) && size > 0 ? size : 0;

    const existing = this.activeAllocations.get(resourceId);
    if (existing) {
      // Re-tracking an active id adjusts usage by the delta (e.g. the size
      // became known after an estimate) instead of double-counting.
      const delta = safeSize - existing.size;
      existing.size = safeSize;
      if (info?.url) existing.url = info.url;
      if (info?.type) existing.type = info.type;
      existing.status = "downloading";
      this.currentUsage = Math.max(0, this.currentUsage + delta);
    } else {
      const queuedIndex = this.resourceQueue.findIndex(
        (r) => r.id === resourceId,
      );
      const base =
        queuedIndex !== -1
          ? this.resourceQueue.splice(queuedIndex, 1)[0]
          : undefined;

      this.activeAllocations.set(resourceId, {
        id: resourceId,
        url: info?.url ?? base?.url ?? "",
        type: info?.type ?? base?.type ?? "unknown",
        size: safeSize,
        timestamp: base?.timestamp ?? Date.now(),
        status: "downloading",
      });
      this.currentUsage += safeSize;
    }

    this.evaluateMemoryPressure();
  }

  /**
   * Release memory when a resource is completed or failed. Releasing an id
   * without an active allocation is a warned no-op that cannot corrupt state.
   */
  public releaseResource(resourceId: string): void {
    const record = this.activeAllocations.get(resourceId);

    if (!record) {
      // Clear any stale pending record for this id as well.
      const queuedIndex = this.resourceQueue.findIndex(
        (r) => r.id === resourceId,
      );
      if (queuedIndex !== -1) {
        this.resourceQueue.splice(queuedIndex, 1);
      }
      console.warn(
        `[MemoryManager] releaseResource called for unknown allocation: ${resourceId}`,
      );
      return;
    }

    this.activeAllocations.delete(resourceId);
    this.currentUsage = Math.max(0, this.currentUsage - record.size);
    this.completedRequests.set(resourceId, {
      ...record,
      status: "completed",
    });

    this.evaluateMemoryPressure();
  }

  /**
   * Mark a resource as failed and release its allocation
   */
  public markResourceFailed(resourceId: string): void {
    const record = this.activeAllocations.get(resourceId);

    if (!record) {
      const queuedIndex = this.resourceQueue.findIndex(
        (r) => r.id === resourceId,
      );
      if (queuedIndex !== -1) {
        const pending = this.resourceQueue.splice(queuedIndex, 1)[0];
        this.completedRequests.set(pending.id, {
          ...pending,
          status: "failed",
        });
      }
      return;
    }

    this.activeAllocations.delete(resourceId);
    this.currentUsage = Math.max(0, this.currentUsage - record.size);
    this.completedRequests.set(resourceId, { ...record, status: "failed" });

    this.evaluateMemoryPressure();
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
   * Force immediate cleanup of all resources.
   *
   * `currentUsage` is recomputed from the set of actually in-flight
   * allocations — never left at a stale cumulative high-water mark.
   */
  public async forceCleanup(): Promise<void> {
    // Run all cleanup callbacks
    const cleanupPromises = this.cleanupCallbacks.map((callback) => callback());
    await Promise.allSettled(cleanupPromises);

    // Clear completed requests older than max age and stale pending records
    this.cleanupOldCompletedRequests();
    this.pruneStalePendingRequests();

    // Recompute usage from live in-flight allocations
    let liveUsage = 0;
    this.activeAllocations.forEach((record) => {
      liveUsage += record.size;
    });
    this.currentUsage = liveUsage;

    // Suggest garbage collection
    this.hintGC();
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
    this.activeAllocations.clear();
    this.completedRequests.clear();
    this.currentUsage = 0;
    this.lastNotifiedLevel = null;
    this.cleanupCallbacks = [];
    this.memoryPressureCallbacks = [];
  }

  /**
   * Evaluate the current pressure level and notify callbacks once per
   * transition. Callbacks fire only when the level enters or leaves the high
   * zone (high/critical) — low/medium transitions stay silent. Levels are
   * compared by numeric rank, never lexicographically.
   */
  private evaluateMemoryPressure(): MemoryPressureLevel {
    const level = this.getMemoryPressureLevel();
    if (this.lastNotifiedLevel === level) {
      return level;
    }

    const previous = this.lastNotifiedLevel;
    this.lastNotifiedLevel = level;

    const entersHighZone = level >= MemoryPressureLevel.HIGH;
    const leavesHighZone =
      previous !== null && previous >= MemoryPressureLevel.HIGH;

    if (entersHighZone || leavesHighZone) {
      this.notifyMemoryPressure(level);
    }

    return level;
  }

  /**
   * Notify pressure callbacks and take critical-pressure actions
   */
  private notifyMemoryPressure(level: MemoryPressureLevel): void {
    for (const callback of this.memoryPressureCallbacks) {
      try {
        callback(level);
      } catch {
        // Ignore listener errors
      }
    }

    if (level === MemoryPressureLevel.CRITICAL) {
      // Recoverable: forceCleanup recomputes usage from live allocations, so
      // the queue can resume once in-flight requests settle.
      void this.forceCleanup();
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
      this.hintGC();
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
    const pressureLevel = this.evaluateMemoryPressure();

    if (pressureLevel >= MemoryPressureLevel.HIGH) {
      this.cleanupOldCompletedRequests();
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
   * Drop pending records that never reached the allocation step
   */
  private pruneStalePendingRequests(): void {
    const now = Date.now();
    this.resourceQueue = this.resourceQueue.filter(
      (request) => now - request.timestamp <= this.config.MAX_BLOB_AGE,
    );
  }

  /**
   * Suggest garbage collection when the host exposes it
   */
  private hintGC(): void {
    const globalGC = (globalThis as { gc?: () => void }).gc;
    if (typeof globalGC === "function") {
      globalGC();
    }
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

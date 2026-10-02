/**
 * Throttling Manager
 * Coordinates adaptive throttling based on memory, network conditions, and system resources
 */

import {
  ThrottlingConfig,
  NetworkCondition,
  QueueEventListeners,
  DEFAULT_THROTTLING_CONFIG,
} from "../types/queue";
import { memoryManager } from "./MemoryManager";

export class ThrottlingManager {
  private config: ThrottlingConfig;
  private eventListeners: QueueEventListeners = {};
  private networkCondition: NetworkCondition = {
    quality: "unknown",
    bandwidth: 0,
    latency: 0,
    congested: false,
    measuredAt: 0,
  };
  private memoryPressureLevel: "low" | "medium" | "high" | "critical" = "low";
  private adaptiveConcurrency: number = 10;
  private networkMonitorInterval: NodeJS.Timeout | null = null;
  private memoryMonitorInterval: NodeJS.Timeout | null = null;
  private requestHistory: Array<{
    timestamp: number;
    duration: number;
    success: boolean;
  }> = [];
  private deduplicationCache: Map<string, { timestamp: number; result: any }> =
    new Map();

  constructor(config?: Partial<ThrottlingConfig>) {
    this.config = { ...DEFAULT_THROTTLING_CONFIG, ...config };
    this.adaptiveConcurrency = this.config.maxConcurrentRequests;

    this.startMonitoring();
  }

  /**
   * Get current adaptive concurrency limit
   */
  public getAdaptiveConcurrency(): number {
    return this.adaptiveConcurrency;
  }

  /**
   * Check if a request should be throttled
   */
  public shouldThrottleRequest(): boolean {
    // Check memory pressure
    if (this.memoryPressureLevel === "critical") {
      return true;
    }

    // Check network congestion (only if severe)
    if (this.isNetworkCongested() && this.getRecentFailureRate() > 0.8) {
      return true;
    }

    return false;
  }

  /**
   * Get delay before next request
   */
  public getThrottleDelay(): number {
    let delay = 0;

    // Add delay based on memory pressure (reduced delays)
    switch (this.memoryPressureLevel) {
      case "critical":
        delay += 200; // Reduced from 1000ms to 200ms
        break;
      case "high":
        delay += 100; // Reduced from 500ms to 100ms
        break;
      case "medium":
        delay += 50; // Reduced from 100ms to 50ms
        break;
    }

    // Add delay based on network congestion (reduced)
    if (this.networkCondition.congested) {
      delay += 100; // Reduced from 500ms to 100ms
    }

    // Add delay based on recent failures (reduced)
    const failureRate = this.getRecentFailureRate();
    if (failureRate > 0.3) {
      delay += 50; // Reduced from 200ms to 50ms
    }

    return delay;
  }

  /**
   * Record a request completion
   */
  public recordRequest(duration: number, success: boolean): void {
    const now = Date.now();
    this.requestHistory.push({
      timestamp: now,
      duration,
      success,
    });

    // Keep only recent history (last 100 requests)
    if (this.requestHistory.length > 100) {
      this.requestHistory.shift();
    }

    // Update adaptive concurrency based on performance
    this.updateAdaptiveConcurrency();
  }

  /**
   * Check if request is duplicated
   */
  public isDuplicateRequest(url: string): boolean {
    if (!this.config.enableDeduplication) {
      return false;
    }

    const cached = this.deduplicationCache.get(url);
    if (!cached) {
      return false;
    }

    const now = Date.now();
    const age = now - cached.timestamp;

    return age < this.config.deduplicationCacheTtl;
  }

  /**
   * Cache a request result
   */
  public cacheRequestResult(url: string, result: any): void {
    if (!this.config.enableDeduplication) {
      return;
    }

    this.deduplicationCache.set(url, {
      timestamp: Date.now(),
      result,
    });

    // Clean up old cache entries
    this.cleanupDeduplicationCache();
  }

  /**
   * Get cached request result
   */
  public getCachedResult(url: string): any | null {
    if (!this.config.enableDeduplication) {
      return null;
    }

    const cached = this.deduplicationCache.get(url);
    if (!cached) {
      return null;
    }

    const now = Date.now();
    const age = now - cached.timestamp;

    if (age < this.config.deduplicationCacheTtl) {
      return cached.result;
    }

    // Remove expired entry
    this.deduplicationCache.delete(url);
    return null;
  }

  /**
   * Get current network condition
   */
  public getNetworkCondition(): NetworkCondition {
    return { ...this.networkCondition };
  }

  /**
   * Get current memory pressure level
   */
  public getMemoryPressureLevel(): "low" | "medium" | "high" | "critical" {
    return this.memoryPressureLevel;
  }

  /**
   * Get current statistics
   */
  public getStats(): {
    adaptiveConcurrency: number;
    memoryPressureLevel: string;
    networkQuality: string;
    recentFailureRate: number;
    averageRequestDuration: number;
    deduplicationCacheSize: number;
  } {
    return {
      adaptiveConcurrency: this.adaptiveConcurrency,
      memoryPressureLevel: this.memoryPressureLevel,
      networkQuality: this.networkCondition.quality,
      recentFailureRate: this.getRecentFailureRate(),
      averageRequestDuration: this.getAverageRequestDuration(),
      deduplicationCacheSize: this.deduplicationCache.size,
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<ThrottlingConfig>): void {
    this.config = { ...this.config, ...config };

    // Update adaptive concurrency if max concurrent requests changed
    if (config.maxConcurrentRequests) {
      this.adaptiveConcurrency = Math.min(
        this.adaptiveConcurrency,
        config.maxConcurrentRequests,
      );
    }
  }

  /**
   * Set event listeners
   */
  public setEventListeners(listeners: QueueEventListeners): void {
    this.eventListeners = listeners;
  }

  /**
   * Shutdown throttling manager
   */
  public shutdown(): void {
    this.stopMonitoring();
    this.requestHistory = [];
    this.deduplicationCache.clear();
  }

  /**
   * Start monitoring systems
   */
  private startMonitoring(): void {
    if (this.config.enableNetworkMonitoring) {
      this.startNetworkMonitoring();
    }

    this.startMemoryMonitoring();
  }

  /**
   * Stop monitoring systems
   */
  private stopMonitoring(): void {
    if (this.networkMonitorInterval) {
      clearInterval(this.networkMonitorInterval);
      this.networkMonitorInterval = null;
    }

    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
      this.memoryMonitorInterval = null;
    }
  }

  /**
   * Start network monitoring
   */
  private startNetworkMonitoring(): void {
    this.networkMonitorInterval = setInterval(() => {
      this.measureNetworkCondition();
    }, 10000); // Measure every 10 seconds

    // Initial measurement
    this.measureNetworkCondition();
  }

  /**
   * Start memory monitoring
   */
  private startMemoryMonitoring(): void {
    this.memoryMonitorInterval = setInterval(() => {
      this.checkMemoryPressure();
    }, 2000); // Check every 2 seconds

    // Initial check
    this.checkMemoryPressure();
  }

  /**
   * Measure network condition
   */
  private async measureNetworkCondition(): Promise<void> {
    try {
      const startTime = Date.now();

      // Simple network test - fetch a small resource
      await fetch("https://www.google.com/favicon.ico", {
        method: "HEAD",
        cache: "no-cache",
        signal: AbortSignal.timeout(5000),
      });

      const endTime = Date.now();
      const latency = endTime - startTime;

      // Update network condition
      this.networkCondition = {
        quality: this.determineNetworkQuality(latency),
        bandwidth: this.estimateBandwidth(),
        latency,
        congested: this.isNetworkCongested(),
        measuredAt: endTime,
      };

      // Notify listeners
      if (this.eventListeners.onNetworkChange) {
        this.eventListeners.onNetworkChange(this.networkCondition);
      }
    } catch (error) {
      // Network measurement failed, assume poor conditions
      this.networkCondition = {
        quality: "slow",
        bandwidth: 0,
        latency: 5000,
        congested: true,
        measuredAt: Date.now(),
      };
    }
  }

  /**
   * Check memory pressure
   */
  private checkMemoryPressure(): void {
    const memoryStats = memoryManager.getMemoryStats();
    const usageRatio =
      memoryStats.totalMemoryUsed / memoryStats.totalMemoryLimit;

    let newLevel: "low" | "medium" | "high" | "critical";

    if (usageRatio >= 0.95) {
      newLevel = "critical";
    } else if (usageRatio >= 0.85) {
      newLevel = "high";
    } else if (usageRatio >= 0.7) {
      newLevel = "medium";
    } else {
      newLevel = "low";
    }

    if (newLevel !== this.memoryPressureLevel) {
      this.memoryPressureLevel = newLevel;

      // Notify listeners
      if (this.eventListeners.onMemoryPressure) {
        this.eventListeners.onMemoryPressure(newLevel);
      }

      // Adjust concurrency based on memory pressure
      this.adjustConcurrencyForMemoryPressure();
    }
  }

  /**
   * Update adaptive concurrency based on performance
   */
  private updateAdaptiveConcurrency(): void {
    const recentRequests = this.getRecentRequests(20); // Last 20 requests
    if (recentRequests.length < 10) {
      return; // Not enough data
    }

    const avgDuration =
      recentRequests.reduce((sum, req) => sum + req.duration, 0) /
      recentRequests.length;
    const failureRate = this.getRecentFailureRate();

    let targetConcurrency = this.adaptiveConcurrency;

    // If requests are slow, reduce concurrency
    if (avgDuration > 10000) {
      // 10 seconds
      targetConcurrency = Math.max(1, Math.floor(targetConcurrency * 0.8));
    }

    // If failure rate is high, reduce concurrency
    if (failureRate > 0.2) {
      // 20% failure rate
      targetConcurrency = Math.max(1, Math.floor(targetConcurrency * 0.7));
    }

    // If requests are fast and reliable, increase concurrency
    if (avgDuration < 2000 && failureRate < 0.05) {
      // 2 seconds, 5% failure rate
      targetConcurrency = Math.min(
        this.config.maxConcurrentRequests,
        targetConcurrency + 1,
      );
    }

    // Apply memory pressure limits
    targetConcurrency = Math.min(
      targetConcurrency,
      this.getMaxConcurrencyForMemoryPressure(),
    );

    if (targetConcurrency !== this.adaptiveConcurrency) {
      this.adaptiveConcurrency = targetConcurrency;
    }
  }

  /**
   * Adjust concurrency for memory pressure
   */
  private adjustConcurrencyForMemoryPressure(): void {
    const maxConcurrency = this.getMaxConcurrencyForMemoryPressure();
    this.adaptiveConcurrency = Math.min(
      this.adaptiveConcurrency,
      maxConcurrency,
    );
  }

  /**
   * Get max concurrency for current memory pressure
   */
  private getMaxConcurrencyForMemoryPressure(): number {
    switch (this.memoryPressureLevel) {
      case "critical":
        return Math.max(1, Math.floor(this.config.maxConcurrentRequests * 0.2));
      case "high":
        return Math.max(2, Math.floor(this.config.maxConcurrentRequests * 0.5));
      case "medium":
        return Math.max(
          3,
          Math.floor(this.config.maxConcurrentRequests * 0.75),
        );
      default:
        return this.config.maxConcurrentRequests;
    }
  }

  /**
   * Determine network quality from latency
   */
  private determineNetworkQuality(
    latency: number,
  ): "slow" | "fast" | "unknown" {
    if (latency < 200) {
      return "fast";
    } else if (latency < 1000) {
      return "fast";
    } else {
      return "slow";
    }
  }

  /**
   * Estimate bandwidth (simplified)
   */
  private estimateBandwidth(): number {
    // This is a simplified implementation
    // In a real scenario, we'd measure actual download speeds
    return this.networkCondition.bandwidth || 1000000; // 1MB/s default
  }

  /**
   * Check if network is congested
   */
  private isNetworkCongested(): boolean {
    const recentRequests = this.getRecentRequests(10);
    if (recentRequests.length < 5) {
      return false;
    }

    const avgDuration =
      recentRequests.reduce((sum, req) => sum + req.duration, 0) /
      recentRequests.length;
    const failureRate = this.getRecentFailureRate();

    // Consider congested if requests are slow or failure rate is high
    return avgDuration > 15000 || failureRate > 0.3;
  }

  /**
   * Get recent requests
   */
  private getRecentRequests(
    count: number,
  ): Array<{ timestamp: number; duration: number; success: boolean }> {
    const now = Date.now();
    const recent = this.requestHistory.filter(
      (req) => now - req.timestamp < 60000,
    ); // Last minute

    return recent.slice(-count);
  }

  /**
   * Get recent failure rate
   */
  private getRecentFailureRate(): number {
    const recentRequests = this.getRecentRequests(20);
    if (recentRequests.length === 0) {
      return 0;
    }

    const failures = recentRequests.filter((req) => !req.success).length;
    return failures / recentRequests.length;
  }

  /**
   * Get average request duration
   */
  private getAverageRequestDuration(): number {
    const recentRequests = this.getRecentRequests(20);
    if (recentRequests.length === 0) {
      return 0;
    }

    const totalDuration = recentRequests.reduce(
      (sum, req) => sum + req.duration,
      0,
    );
    return totalDuration / recentRequests.length;
  }

  /**
   * Clean up deduplication cache
   */
  private cleanupDeduplicationCache(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [url, entry] of this.deduplicationCache.entries()) {
      if (now - entry.timestamp > this.config.deduplicationCacheTtl) {
        toDelete.push(url);
      }
    }

    for (const url of toDelete) {
      this.deduplicationCache.delete(url);
    }
  }
}

/**
 * Adaptive Memory Manager for WebsiteDownloader Extension
 * Dynamically adjusts memory limits based on runtime conditions
 */

export interface MemoryStats {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
  availableMemory: number;
  memoryPressureLevel: MemoryPressureLevel;
}

export enum MemoryPressureLevel {
  LOW = "low", // < 50% memory usage
  MEDIUM = "medium", // 50-75% memory usage
  HIGH = "high", // 75-85% memory usage
  CRITICAL = "critical", // > 85% memory usage
}

export interface MemoryConfig {
  MIN_LIMIT: number; // Minimum memory limit (10MB)
  MAX_LIMIT: number; // Maximum memory limit (500MB)
  SAFETY_FACTOR: number; // Safety factor for memory calculations (0.5 = 50%)
  CHUNK_SIZE_LIMIT: number; // Maximum size for individual chunks (5MB)
}

export class AdaptiveMemoryManager {
  private static readonly DEFAULT_CONFIG: MemoryConfig = {
    MIN_LIMIT: 10 * 1024 * 1024, // 10MB
    MAX_LIMIT: 500 * 1024 * 1024, // 500MB
    SAFETY_FACTOR: 0.5, // Use 50% of available memory
    CHUNK_SIZE_LIMIT: 5 * 1024 * 1024, // 5MB per chunk
  };

  private config: MemoryConfig;

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...AdaptiveMemoryManager.DEFAULT_CONFIG, ...config };
  }

  /**
   * Get available memory information
   */
  getMemoryStats(): MemoryStats {
    // Chrome specific API
    const performanceMemory = (performance as any).memory;
    
    if (performanceMemory) {
      const jsHeapSizeLimit = performanceMemory.jsHeapSizeLimit;
      const totalJSHeapSize = performanceMemory.totalJSHeapSize;
      const usedJSHeapSize = performanceMemory.usedJSHeapSize;
      const availableMemory = jsHeapSizeLimit - usedJSHeapSize;
      
      const memoryUsageRatio = usedJSHeapSize / jsHeapSizeLimit;
      let memoryPressureLevel: MemoryPressureLevel;

      if (memoryUsageRatio < 0.5) {
        memoryPressureLevel = MemoryPressureLevel.LOW;
      } else if (memoryUsageRatio < 0.75) {
        memoryPressureLevel = MemoryPressureLevel.MEDIUM;
      } else if (memoryUsageRatio < 0.85) {
        memoryPressureLevel = MemoryPressureLevel.HIGH;
      } else {
        memoryPressureLevel = MemoryPressureLevel.CRITICAL;
      }

      return {
        jsHeapSizeLimit,
        totalJSHeapSize,
        usedJSHeapSize,
        availableMemory,
        memoryPressureLevel,
      };
    }

    // Fallback for environments without performance.memory
    return {
      jsHeapSizeLimit: this.config.MAX_LIMIT,
      totalJSHeapSize: this.config.MIN_LIMIT,
      usedJSHeapSize: 0,
      availableMemory: this.config.MIN_LIMIT,
      memoryPressureLevel: MemoryPressureLevel.LOW,
    };
  }

  /**
   * Calculate safe HTML limit based on current memory conditions
   */
  calculateSafeHtmlLimit(): number {
    const stats = this.getMemoryStats();
    const safeLimit = Math.floor(stats.availableMemory * this.config.SAFETY_FACTOR);
    
    return Math.max(
      this.config.MIN_LIMIT,
      Math.min(safeLimit, this.config.MAX_LIMIT)
    );
  }

  /**
   * Calculate safe chunk size based on current memory conditions
   */
  calculateSafeChunkSize(): number {
    const stats = this.getMemoryStats();
    const htmlLimit = this.calculateSafeHtmlLimit();
    
    // For high memory pressure, use smaller chunks
    let chunkSize = this.config.CHUNK_SIZE_LIMIT;
    
    switch (stats.memoryPressureLevel) {
      case MemoryPressureLevel.HIGH:
        chunkSize = Math.floor(this.config.CHUNK_SIZE_LIMIT * 0.5);
        break;
      case MemoryPressureLevel.CRITICAL:
        chunkSize = Math.floor(this.config.CHUNK_SIZE_LIMIT * 0.25);
        break;
    }

    // Ensure chunk size is reasonable relative to HTML limit
    const maxChunkSize = Math.floor(htmlLimit * 0.1); // Max 10% of HTML limit
    return Math.min(chunkSize, maxChunkSize, this.config.CHUNK_SIZE_LIMIT);
  }

  /**
   * Check if there's enough memory for a given operation
   */
  checkMemoryAvailability(requiredBytes: number): boolean {
    const stats = this.getMemoryStats();
    const safeLimit = this.calculateSafeHtmlLimit();
    
    // Check if we have enough available memory with safety factor
    const availableForOperation = stats.availableMemory * this.config.SAFETY_FACTOR;
    
    return availableForOperation >= requiredBytes && requiredBytes <= safeLimit;
  }

  /**
   * Get memory pressure level
   */
  getMemoryPressureLevel(): MemoryPressureLevel {
    return this.getMemoryStats().memoryPressureLevel;
  }

  /**
   * Check if memory pressure is high enough to trigger cleanup
   */
  shouldTriggerCleanup(): boolean {
    const level = this.getMemoryPressureLevel();
    return level === MemoryPressureLevel.HIGH || level === MemoryPressureLevel.CRITICAL;
  }

  /**
   * Check if memory pressure is critical and operations should be paused
   */
  shouldPauseOperations(): boolean {
    return this.getMemoryPressureLevel() === MemoryPressureLevel.CRITICAL;
  }

  /**
   * Get recommended action based on current memory pressure
   */
  getRecommendedAction(): {
    action: 'continue' | 'cleanup' | 'pause' | 'stop';
    reason: string;
  } {
    const stats = this.getMemoryStats();
    
    switch (stats.memoryPressureLevel) {
      case MemoryPressureLevel.LOW:
        return {
          action: 'continue',
          reason: 'Memory usage is low, operations can continue normally',
        };
      
      case MemoryPressureLevel.MEDIUM:
        return {
          action: 'continue',
          reason: 'Memory usage is moderate, consider monitoring',
        };
      
      case MemoryPressureLevel.HIGH:
        return {
          action: 'cleanup',
          reason: 'Memory usage is high, cleanup recommended',
        };
      
      case MemoryPressureLevel.CRITICAL:
        return {
          action: 'pause',
          reason: 'Memory usage is critical, operations should be paused',
        };
      
      default:
        return {
          action: 'continue',
          reason: 'Unknown memory state, proceeding with caution',
        };
    }
  }

  /**
   * Format bytes to human readable format
   */
  formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)}${units[unitIndex]}`;
  }

  /**
   * Get memory usage summary for logging
   */
  getMemorySummary(): string {
    const stats = this.getMemoryStats();
    const htmlLimit = this.calculateSafeHtmlLimit();
    const chunkSize = this.calculateSafeChunkSize();
    
    return `Memory: ${this.formatBytes(stats.usedJSHeapSize)}/${this.formatBytes(stats.jsHeapSizeLimit)} (${Math.round((stats.usedJSHeapSize / stats.jsHeapSizeLimit) * 100)}%), Pressure: ${stats.memoryPressureLevel}, HTML Limit: ${this.formatBytes(htmlLimit)}, Chunk Size: ${this.formatBytes(chunkSize)}`;
  }
}

// Export singleton instance
export const adaptiveMemoryManager = new AdaptiveMemoryManager();
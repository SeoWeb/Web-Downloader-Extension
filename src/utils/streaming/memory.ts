
import { MEMORY_THRESHOLDS, MemoryPressureInfo } from '../../types/streaming';
import { memoryManager } from '../MemoryManager';

export class MemoryMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onPressureChange?: (pressure: MemoryPressureInfo) => void;

  constructor(
    private enabled: boolean = true
  ) {}

  public start(onPressureChange: (pressure: MemoryPressureInfo) => void): void {
    if (!this.enabled) return;
    
    this.onPressureChange = onPressureChange;
    
    this.intervalId = setInterval(async () => {
      const pressure = this.getMemoryPressure();
      if (pressure.level !== 'low') {
        this.onPressureChange?.(pressure);
      }
    }, 5000); // Check every 5 seconds
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Get current memory pressure
   */
  public getMemoryPressure(): MemoryPressureInfo {
    const memoryStats = memoryManager.getMemoryStats();
    // Default fallback logic matching original implementation
    const percentageUsed = memoryStats.memoryPressureLevel === 'critical' ? 1 :
                          memoryStats.memoryPressureLevel === 'high' ? 0.9 :
                          memoryStats.memoryPressureLevel === 'medium' ? 0.8 : 0.6;

    let level: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (percentageUsed >= MEMORY_THRESHOLDS.CRITICAL) {
      level = 'critical';
    } else if (percentageUsed >= MEMORY_THRESHOLDS.HIGH) {
      level = 'high';
    } else if (percentageUsed >= MEMORY_THRESHOLDS.MEDIUM) {
      level = 'medium';
    }

    return {
      level,
      bytesUsed: memoryStats.totalMemoryUsed,
      bytesLimit: memoryStats.totalMemoryLimit,
      percentageUsed,
      shouldPause: level === 'critical',
      shouldReduceParallelism: level === 'high' || level === 'critical',
    };
  }
}

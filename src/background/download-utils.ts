
import { memoryManager } from "../utils/MemoryManager";
import { MemoryPressureLevel } from "../utils/memoryLimits";

/**
 * Format bytes to human readable format
 */
export function formatBytes(bytes: number): string {
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
 * Perform memory cleanup at the start of download
 */
export async function performInitialCleanup(): Promise<void> {
  try {
    // Get memory usage stats
    const memoryStats = memoryManager.getMemoryStats();

    // If memory pressure is already high, perform more aggressive cleanup
    if (
      memoryStats.memoryPressureLevel === MemoryPressureLevel.HIGH ||
      memoryStats.memoryPressureLevel === MemoryPressureLevel.CRITICAL
    ) {
      await memoryManager.forceCleanup();
    }
  } catch {
    // ignore
  }
}

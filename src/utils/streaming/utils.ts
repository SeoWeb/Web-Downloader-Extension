
import { StreamingDownload } from '../../types/streaming';

/**
 * Generate a unique download ID
 */
export function generateDownloadId(url: string): string {
  const urlHash = simpleHash(url);
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return `stream-${urlHash}-${timestamp}-${random}`;
}

/**
 * Simple hash function for URLs
 */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Calculate download speed in bytes per second
 */
export function calculateDownloadSpeed(download: StreamingDownload): number {
  const timeElapsed = Date.now() - download.startedAt;
  if (timeElapsed === 0) return 0;
  return (download.downloadedSize * 1000) / timeElapsed;
}

/**
 * Calculate estimated time remaining (ETA) in seconds
 */
export function calculateETA(download: StreamingDownload, speed: number): number {
  if (speed === 0 || download.totalSize === 0) return 0;
  const remainingBytes = download.totalSize - download.downloadedSize;
  return remainingBytes / speed;
}

/**
 * Check if a promise is settled
 */
export async function isPromiseSettled(promise: Promise<any>): Promise<boolean> {
  try {
    await Promise.race([promise, Promise.resolve('pending')]);
    return promise !== Promise.resolve('pending');
  } catch {
    return true;
  }
}

/**
 * Calculate checksum for data integrity
 */
export async function calculateChecksum(data: ArrayBuffer): Promise<string> {
  // Simple checksum implementation - in production, use crypto.subtle.digest
  const view = new Uint8Array(data);
  let hash = 0;
  for (let i = 0; i < view.length; i++) {
    hash = ((hash << 5) - hash + view[i]) & 0xffffffff;
  }
  return hash.toString(16);
}

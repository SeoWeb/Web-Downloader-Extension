import {
  ChunkInfo,
  StreamingDownload,
  StreamingOptions,
} from "../../types/streaming";
import { calculateChecksum } from "./utils";

/**
 * Calculate optimal chunk size based on file size and memory constraints
 */
export function calculateOptimalChunkSize(
  fileSize: number,
  options: StreamingOptions,
): number {
  const baseChunkSize = options.chunkSize!;

  // Adjust based on file size
  if (fileSize > 100 * 1024 * 1024) {
    // > 100MB
    return Math.min(baseChunkSize * 2, 5 * 1024 * 1024); // Max 5MB
  } else if (fileSize > 10 * 1024 * 1024) {
    // > 10MB
    return baseChunkSize;
  } else {
    return Math.max(baseChunkSize / 2, 256 * 1024); // Min 256KB
  }
}

/**
 * Generate chunks for a new download
 */
export function generateChunks(
  totalSize: number,
  chunkSize: number,
): ChunkInfo[] {
  const totalChunks = Math.ceil(totalSize / chunkSize);

  const chunks: ChunkInfo[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, totalSize - 1);

    chunks.push({
      index: i,
      start,
      end,
      size: end - start + 1,
      downloaded: false,
      retryCount: 0,
    });
  }
  return chunks;
}

/**
 * Validate chunk checksum
 */
export async function validateChunkChecksum(
  chunk: ChunkInfo,
): Promise<boolean> {
  if (!chunk.data || !chunk.checksum) return false;

  const calculatedChecksum = await calculateChecksum(
    chunk.data instanceof ArrayBuffer
      ? chunk.data
      : await (chunk.data as Blob).arrayBuffer(),
  );

  return calculatedChecksum === chunk.checksum;
}

/**
 * Validate existing chunks in a resumed download
 */
export async function validateExistingChunks(
  download: StreamingDownload,
  options: StreamingOptions,
): Promise<ChunkInfo[]> {
  const validChunks: ChunkInfo[] = [];

  for (const chunk of download.chunks) {
    if (chunk.downloaded && chunk.data) {
      // Validate chunk data integrity if checksum is available
      if (options.enableChecksums && chunk.checksum) {
        const isValid = await validateChunkChecksum(chunk);
        if (isValid) {
          validChunks.push(chunk);
        } else {
          // Mark as not downloaded if checksum fails
          validChunks.push({
            ...chunk,
            downloaded: false,
            data: undefined,
            checksum: undefined,
            retryCount: 0,
          });
        }
      } else {
        validChunks.push(chunk);
      }
    } else {
      validChunks.push(chunk);
    }
  }

  return validChunks;
}

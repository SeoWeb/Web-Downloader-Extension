import JSZip from "jszip";

export interface FilePartition {
  partNumber: number;
  files: Array<{
    path: string;
    file: JSZip.JSZipObject;
  }>;
  estimatedSize: number;
  description: string;
}

const MAX_PART_SIZE = 100 * 1024 * 1024; // 100MB
export const SPLIT_THRESHOLD = 100 * 1024 * 1024; // 100MB - Trigger multi-part if total > 100MB

/**
 * Estimate the size of a JSZip object file.
 * Generates the actual compressed data to get accurate size.
 */
async function estimateFileSize(file: JSZip.JSZipObject): Promise<number> {
  try {
    // Generate the compressed blob to get actual size
    const blob = await file.async('blob');
    return blob.size;
  } catch {
    return 1024; // 1KB fallback
  }
}

/**
 * Partition files from a JSZip object into multiple partitions.
 */
export async function partitionFiles(zip: JSZip): Promise<FilePartition[]> {
  const files: Array<{ path: string; file: JSZip.JSZipObject; size: number }> = [];
  
  // 1. Extract and size all files
  let totalSize = 0;
  const filePromises: Promise<void>[] = [];
  
  zip.forEach((relativePath, file) => {
    // Check if it's a directory
    if (file.dir) return;

    const promise = estimateFileSize(file).then(size => {
      totalSize += size;
      files.push({
        path: relativePath,
        file,
        size
      });
    });
    filePromises.push(promise);
  });
  
  // Wait for all size estimations to complete
  await Promise.all(filePromises);

  // If total size is small enough, return single partition
  if (totalSize < SPLIT_THRESHOLD) {
    return [{
      partNumber: 1,
      files: files.map(f => ({ path: f.path, file: f.file })),
      estimatedSize: totalSize,
      description: "Complete archive"
    }];
  }

  // 2. Sort files to keep folder structure somewhat together, 
  // but also prioritize filling partitions efficiently?
  // Actually, keeping directory structure together is nicer for extraction if they extract one by one.
  // But for simple "extract all here", order doesn't matter strictly.
  // Let's simple sort by path to keep related files together.
  files.sort((a, b) => a.path.localeCompare(b.path));

  const partitions: FilePartition[] = [];
  let currentPartitionRequest: FilePartition = {
    partNumber: 1,
    files: [],
    estimatedSize: 0,
    description: "Part 1"
  };

  for (const fileData of files) {
    // If adding this file exceeds max size AND we have files in current partition
    // AND the file itself isn't massive (if it's massive, it consumes a whole partition anyway)
    if (
      currentPartitionRequest.estimatedSize + fileData.size > MAX_PART_SIZE &&
      currentPartitionRequest.files.length > 0
    ) {
      // Push current partition
      partitions.push(currentPartitionRequest);
      
      // Start new partition
      currentPartitionRequest = {
        partNumber: partitions.length + 1,
        files: [],
        estimatedSize: 0,
        description: `Part ${partitions.length + 1}`
      };
    }

    currentPartitionRequest.files.push({
      path: fileData.path,
      file: fileData.file
    });
    currentPartitionRequest.estimatedSize += fileData.size;
  }

  // Push the last partition if it has files
  if (currentPartitionRequest.files.length > 0) {
    partitions.push(currentPartitionRequest);
  }

  return partitions;
}

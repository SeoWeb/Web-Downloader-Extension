import { FileStore } from './file-store';
import i18n from '../../i18n/config';

export interface FilePartitionMetadata {
  partNumber: number;
  fileIds: string[];  // IDs in IndexedDB
  estimatedSize: number;
  description: string;
}

const MAX_PART_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * Partition files stored in IndexedDB
 */
export async function partitionIndexedDBFiles(
  downloadId: string
): Promise<FilePartitionMetadata[]> {
  // Get file metadata (not blobs)
  const files = await FileStore.getFileMetadata(downloadId);
  
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  
  // Single partition if small enough
  if (totalSize < MAX_PART_SIZE) {
    return [{
      partNumber: 1,
      fileIds: files.map(f => f.id),
      estimatedSize: totalSize,
      description: i18n.t('generated.completeArchive')
    }];
  }
  
  // Sort by path to keep related files together
  files.sort((a, b) => a.path.localeCompare(b.path));
  
  const partitions: FilePartitionMetadata[] = [];
  let currentPartition: FilePartitionMetadata = {
    partNumber: 1,
    fileIds: [],
    estimatedSize: 0,
    description: i18n.t('generated.partDescription', { number: 1 })
  };
  
  for (const file of files) {
    // Start new partition if adding this file exceeds limit
    if (
      currentPartition.estimatedSize + file.size > MAX_PART_SIZE &&
      currentPartition.fileIds.length > 0
    ) {
      partitions.push(currentPartition);
      currentPartition = {
        partNumber: partitions.length + 1,
        fileIds: [],
        estimatedSize: 0,
        description: i18n.t('generated.partDescription', { number: partitions.length + 1 })
      };
    }
    
    currentPartition.fileIds.push(file.id);
    currentPartition.estimatedSize += file.size;
  }
  
  // Push last partition
  if (currentPartition.fileIds.length > 0) {
    partitions.push(currentPartition);
  }
  
  return partitions;
}
